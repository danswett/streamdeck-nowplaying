using System.Security.Cryptography;
using Windows.Foundation;
using Windows.Graphics.Imaging;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace SmtcBridge;

/// <summary>
/// Watches every System Media Transport Controls session on the machine.
///
/// SMTC is the only vendor-neutral view of "what is playing" on Windows: any
/// app that publishes transport controls shows up here, which is what lets one
/// dial drive Spotify, TIDAL, Plexamp and browser players without per-app
/// integrations. The catch is that it is strictly local - audio streamed from a
/// server to a *different* endpoint is invisible.
/// </summary>
internal sealed class Watcher : IDisposable
{
    private GlobalSystemMediaTransportControlsSessionManager? _manager;

    private readonly Dictionary<string, Registration> _hooks = [];
    private readonly Lock _gate = new();

    /// <summary>Art ids already written to the client, so bytes are sent once.</summary>
    private readonly HashSet<string> _sentArt = [];

    /// <summary>Raised whenever anything observable changed.</summary>
    public event Action? Changed;

    private sealed record Registration(
        GlobalSystemMediaTransportControlsSession Session,
        TypedEventHandler<GlobalSystemMediaTransportControlsSession, MediaPropertiesChangedEventArgs> Media,
        TypedEventHandler<GlobalSystemMediaTransportControlsSession, PlaybackInfoChangedEventArgs> Playback,
        TypedEventHandler<GlobalSystemMediaTransportControlsSession, TimelinePropertiesChangedEventArgs> Timeline);

    public async Task StartAsync()
    {
        _manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        _manager.SessionsChanged += (_, _) => { Rehook(); Changed?.Invoke(); };
        _manager.CurrentSessionChanged += (_, _) => Changed?.Invoke();
        Rehook();
    }

    /// <summary>
    /// Rebinds per-session handlers to match the live session list.
    ///
    /// The manager only reports that the *set* of sessions changed, so the
    /// handlers have to be reconciled by id rather than incrementally.
    /// </summary>
    private void Rehook()
    {
        var manager = _manager;
        if (manager is null) return;

        IReadOnlyList<GlobalSystemMediaTransportControlsSession> sessions;
        try { sessions = manager.GetSessions(); }
        catch { return; }

        lock (_gate)
        {
            var live = new HashSet<string>(StringComparer.Ordinal);

            foreach (var session in sessions)
            {
                var id = session.SourceAppUserModelId;
                if (string.IsNullOrEmpty(id)) continue;
                live.Add(id);
                if (_hooks.ContainsKey(id)) continue;

                void Fire() => Changed?.Invoke();
                TypedEventHandler<GlobalSystemMediaTransportControlsSession, MediaPropertiesChangedEventArgs> media = (_, _) => Fire();
                TypedEventHandler<GlobalSystemMediaTransportControlsSession, PlaybackInfoChangedEventArgs> playback = (_, _) => Fire();
                TypedEventHandler<GlobalSystemMediaTransportControlsSession, TimelinePropertiesChangedEventArgs> timeline = (_, _) => Fire();

                session.MediaPropertiesChanged += media;
                session.PlaybackInfoChanged += playback;
                session.TimelinePropertiesChanged += timeline;

                _hooks[id] = new Registration(session, media, playback, timeline);
            }

            foreach (var id in _hooks.Keys.Where(k => !live.Contains(k)).ToList())
            {
                Unhook(_hooks[id]);
                _hooks.Remove(id);
            }
        }
    }

    private static void Unhook(Registration hook)
    {
        try
        {
            hook.Session.MediaPropertiesChanged -= hook.Media;
            hook.Session.PlaybackInfoChanged -= hook.Playback;
            hook.Session.TimelinePropertiesChanged -= hook.Timeline;
        }
        catch
        {
            // The owning app is already gone; nothing to detach from.
        }
    }

    /// <summary>Forces artwork to be resent on the next snapshot.</summary>
    public void ResetArtCache()
    {
        lock (_gate) _sentArt.Clear();
    }

    private GlobalSystemMediaTransportControlsSession? Find(string? target)
    {
        var manager = _manager;
        if (manager is null) return null;
        try
        {
            if (string.IsNullOrEmpty(target)) return manager.GetCurrentSession();
            foreach (var session in manager.GetSessions())
            {
                if (string.Equals(session.SourceAppUserModelId, target, StringComparison.Ordinal)) return session;
            }
            // A pinned app that is not running falls back to nothing rather
            // than silently driving whatever else happens to be playing.
            return null;
        }
        catch
        {
            return null;
        }
    }

    // -- transport ----------------------------------------------------------

    public async Task<bool> ToggleAsync(string? target)
    {
        var session = Find(target);
        if (session is null) return false;
        try
        {
            // TryTogglePlayPauseAsync is deliberate: when paused, SMTC reports
            // IsPauseEnabled=false and only IsPlayEnabled, so branching on the
            // capability flags means handling both directions anyway.
            return await session.TryTogglePlayPauseAsync();
        }
        catch { return false; }
    }

    public async Task<bool> PlayAsync(string? target)
    {
        var session = Find(target);
        if (session is null) return false;
        try { return await session.TryPlayAsync(); } catch { return false; }
    }

    public async Task<bool> PauseAsync(string? target)
    {
        var session = Find(target);
        if (session is null) return false;
        try { return await session.TryPauseAsync(); } catch { return false; }
    }

    public async Task<bool> NextAsync(string? target)
    {
        var session = Find(target);
        if (session is null) return false;
        try { return await session.TrySkipNextAsync(); } catch { return false; }
    }

    public async Task<bool> PreviousAsync(string? target)
    {
        var session = Find(target);
        if (session is null) return false;
        try { return await session.TrySkipPreviousAsync(); } catch { return false; }
    }

    public async Task<bool> SeekAsync(string? target, long positionMs)
    {
        var session = Find(target);
        if (session is null) return false;
        try { return await session.TryChangePlaybackPositionAsync(positionMs * TimeSpan.TicksPerMillisecond); }
        catch { return false; }
    }

    /// <summary>Resolves the id a command should act on, for per-app volume.</summary>
    public string? Resolve(string? target) => Find(target)?.SourceAppUserModelId;

    // -- snapshot -----------------------------------------------------------

    public async Task<StatePayload> SnapshotAsync()
    {
        var payload = new StatePayload();
        var (volume, muted) = Audio.GetSystem();
        payload.Volume = volume;
        payload.Muted = muted;

        var manager = _manager;
        if (manager is null) return payload;

        try { payload.Current = manager.GetCurrentSession()?.SourceAppUserModelId; }
        catch { /* no current session */ }

        IReadOnlyList<GlobalSystemMediaTransportControlsSession> sessions;
        try { sessions = manager.GetSessions(); }
        catch { return payload; }

        foreach (var session in sessions)
        {
            var item = await DescribeAsync(session);
            if (item is not null) payload.Sessions.Add(item);
        }

        return payload;
    }

    private async Task<SessionPayload?> DescribeAsync(GlobalSystemMediaTransportControlsSession session)
    {
        string id;
        try { id = session.SourceAppUserModelId; }
        catch { return null; }
        if (string.IsNullOrEmpty(id)) return null;

        var item = new SessionPayload { Id = id, App = AppIdentity.FriendlyName(id) };

        try
        {
            var info = session.GetPlaybackInfo();
            item.Status = info.PlaybackStatus switch
            {
                GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing => "playing",
                GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused => "paused",
                GlobalSystemMediaTransportControlsSessionPlaybackStatus.Stopped => "stopped",
                GlobalSystemMediaTransportControlsSessionPlaybackStatus.Changing => "changing",
                GlobalSystemMediaTransportControlsSessionPlaybackStatus.Opened => "opened",
                GlobalSystemMediaTransportControlsSessionPlaybackStatus.Closed => "closed",
                _ => "unknown"
            };
            var controls = info.Controls;
            item.CanPlayPause = controls.IsPlayPauseToggleEnabled || controls.IsPlayEnabled || controls.IsPauseEnabled;
            item.CanNext = controls.IsNextEnabled;
            item.CanPrev = controls.IsPreviousEnabled;
            item.CanSeek = controls.IsPlaybackPositionEnabled;
            item.Rate = info.PlaybackRate ?? 1.0;
        }
        catch { /* leave defaults */ }

        try
        {
            var timeline = session.GetTimelineProperties();
            var duration = timeline.EndTime - timeline.StartTime;
            if (duration > TimeSpan.Zero)
            {
                item.DurationMs = (long)duration.TotalMilliseconds;
                item.PositionMs = (long)(timeline.Position - timeline.StartTime).TotalMilliseconds;
                var stamp = timeline.LastUpdatedTime;
                item.PositionAt = stamp.Year > 1
                    ? stamp.ToUnixTimeMilliseconds()
                    : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            }
        }
        catch { /* no timeline */ }

        try
        {
            var properties = await session.TryGetMediaPropertiesAsync();
            if (properties is not null)
            {
                item.Title = properties.Title ?? "";
                item.Artist = properties.Artist ?? "";
                item.Album = properties.AlbumTitle ?? "";
                item.AlbumArtist = properties.AlbumArtist ?? "";
                item.TrackNumber = properties.TrackNumber;

                var art = await ReadArtAsync(properties.Thumbnail);
                if (art is not null)
                {
                    item.ArtId = art.Value.Id;
                    bool fresh;
                    lock (_gate) fresh = _sentArt.Add(art.Value.Id);
                    if (fresh) item.Art = art.Value.DataUri;
                }
            }
        }
        catch { /* app closed mid-read */ }

        var audio = Audio.GetApp(id);
        item.AppVolume = audio?.Volume;
        item.AppMuted = audio?.Muted;
        item.AppExclusive = audio?.Exclusive;
        return item;
    }

    /// <summary>
    /// Pulls artwork bytes out of the session's thumbnail reference.
    ///
    /// The read is bounded because the reference is served by the media app
    /// itself: a wedged or shutting-down player can leave the call outstanding
    /// indefinitely, which would stall every subsequent snapshot.
    /// </summary>
    private static async Task<(string Id, string DataUri)?> ReadArtAsync(IRandomAccessStreamReference? reference)
    {
        if (reference is null) return null;
        try
        {
            using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            using var stream = await reference.OpenReadAsync().AsTask(cancel.Token);
            if (stream.Size is 0 or > 8 * 1024 * 1024) return null;

            var size = (uint)stream.Size;
            using var reader = new DataReader(stream.GetInputStreamAt(0));
            await reader.LoadAsync(size).AsTask(cancel.Token);

            var bytes = new byte[size];
            reader.ReadBytes(bytes);

            var id = Convert.ToHexString(SHA256.HashData(bytes))[..16];
            var (encoded, mime) = await ShrinkAsync(bytes, stream.ContentType, cancel.Token);
            return (id, $"data:{mime};base64,{Convert.ToBase64String(encoded)}");
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Longest edge kept for artwork, in pixels.</summary>
    /// <remarks>
    /// The art slot is 88x88 layout units, which is 176px on the device's 2x
    /// touch strip. Players publish far larger: Plex serves 1280x1280, about
    /// 435 KB once base64'd, for every track change. Sending that through the
    /// Stream Deck websocket is wasteful at best and is the kind of payload a
    /// host may simply drop.
    /// </remarks>
    private const uint MaxArtEdge = 192;

    /// <summary>
    /// Scales artwork down to something proportionate to the slot it lands in.
    ///
    /// Falls back to the original bytes whenever anything goes wrong: sending
    /// a large image is far better than sending none.
    /// </summary>
    private static async Task<(byte[] Bytes, string Mime)> ShrinkAsync(
        byte[] bytes,
        string? contentType,
        CancellationToken token)
    {
        var mime = MimeFor(bytes, contentType);

        try
        {
            using var source = new InMemoryRandomAccessStream();
            using (var writer = new DataWriter(source))
            {
                writer.WriteBytes(bytes);
                await writer.StoreAsync().AsTask(token);
                writer.DetachStream();
            }
            source.Seek(0);

            var decoder = await BitmapDecoder.CreateAsync(source).AsTask(token);
            var scale = Math.Min(
                (double)MaxArtEdge / decoder.PixelWidth,
                (double)MaxArtEdge / decoder.PixelHeight);

            // Already small enough; re-encoding would only lose quality.
            if (scale >= 1) return (bytes, mime);

            using var output = new InMemoryRandomAccessStream();
            var encoder = await BitmapEncoder.CreateForTranscodingAsync(output, decoder).AsTask(token);
            encoder.BitmapTransform.InterpolationMode = BitmapInterpolationMode.Fant;
            encoder.BitmapTransform.ScaledWidth = (uint)Math.Max(1, Math.Round(decoder.PixelWidth * scale));
            encoder.BitmapTransform.ScaledHeight = (uint)Math.Max(1, Math.Round(decoder.PixelHeight * scale));
            await encoder.FlushAsync().AsTask(token);

            output.Seek(0);
            var shrunk = new byte[output.Size];
            using (var reader = new DataReader(output))
            {
                await reader.LoadAsync((uint)output.Size).AsTask(token);
                reader.ReadBytes(shrunk);
            }

            return shrunk.Length > 0 && shrunk.Length < bytes.Length
                ? (shrunk, MimeFor(shrunk, mime))
                : (bytes, mime);
        }
        catch (Exception ex)
        {
            try { Console.Error.WriteLine($"[art] shrink failed, sending original: {ex.GetType().Name}: {ex.Message}"); }
            catch { }
            return (bytes, mime);
        }
    }

    /// <summary>
    /// Chooses the MIME type to declare in the artwork data URI.
    ///
    /// The bytes are trusted ahead of the app's own content type, because that
    /// header is not always a single value. Plex reports
    /// <c>image/jpeg,image/jpe,image/jpg</c>, which embedded verbatim yields
    /// <c>data:image/jpeg,image/jpe,image/jpg;base64,...</c> - and a data URI
    /// parser stops at the first comma, so it sees a plain <c>image/jpeg</c>
    /// payload with no base64 flag and decodes the remainder as text. The
    /// artwork then fails to render with no error anywhere.
    /// </summary>
    private static string MimeFor(byte[] bytes, string? contentType)
    {
        if (Sniff(bytes) is { } sniffed) return sniffed;

        // Nothing recognisable in the bytes: fall back to the first declared
        // type, provided it survives being cut at the first separator.
        var declared = contentType?.Split(',', ';')[0].Trim();
        if (!string.IsNullOrEmpty(declared) && declared.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
        {
            return declared;
        }

        return "image/jpeg";
    }

    /// <summary>Image type implied by the leading bytes, or null if unknown.</summary>
    private static string? Sniff(byte[] bytes)
    {
        if (bytes.Length >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF) return "image/jpeg";
        if (bytes.Length >= 8 && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47) return "image/png";
        if (bytes.Length >= 12 && bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[8] == 0x57 && bytes[9] == 0x45) return "image/webp";
        if (bytes.Length >= 6 && bytes[0] == 0x47 && bytes[1] == 0x49 && bytes[2] == 0x46) return "image/gif";
        if (bytes.Length >= 2 && bytes[0] == 0x42 && bytes[1] == 0x4D) return "image/bmp";
        return null;
    }

    public void Dispose()
    {
        lock (_gate)
        {
            foreach (var hook in _hooks.Values) Unhook(hook);
            _hooks.Clear();
        }
    }
}
