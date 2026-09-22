using Windows.Media.Control;

namespace SmtcBridge;

/// <summary>
/// Human-readable dump of everything the bridge can see, for support.
///
/// Both SMTC and Core Audio fail quietly: a player can publish a session with
/// no timeline, or hold a mixer entry on a device it is not actually rendering
/// to, and either looks from the outside like the plugin is broken. Printing
/// the raw values is the only reliable way to tell those apart.
/// </summary>
internal static class Diagnostics
{
    public static async Task RunAsync()
    {
        Console.WriteLine("=== SMTC sessions ===");

        GlobalSystemMediaTransportControlsSessionManager manager;
        try
        {
            manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"  SMTC unavailable: {ex.Message}");
            return;
        }

        var current = manager.GetCurrentSession()?.SourceAppUserModelId;
        Console.WriteLine($"  current: {current ?? "<none>"}");

        foreach (var session in manager.GetSessions())
        {
            Console.WriteLine();
            Console.WriteLine($"  [{session.SourceAppUserModelId}]");

            try
            {
                var info = session.GetPlaybackInfo();
                var controls = info.Controls;
                Console.WriteLine($"    status           : {info.PlaybackStatus}");
                Console.WriteLine($"    rate             : {info.PlaybackRate?.ToString() ?? "<null>"}");
                Console.WriteLine($"    type             : {info.PlaybackType?.ToString() ?? "<null>"}");
                Console.WriteLine(
                    $"    controls         : play={controls.IsPlayEnabled} pause={controls.IsPauseEnabled} " +
                    $"toggle={controls.IsPlayPauseToggleEnabled} next={controls.IsNextEnabled} " +
                    $"prev={controls.IsPreviousEnabled} position={controls.IsPlaybackPositionEnabled} " +
                    $"rate={controls.IsPlaybackRateEnabled}");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"    playback info failed: {ex.Message}");
            }

            // The interesting part: which timeline fields a player actually
            // populates. Several publish only some of them.
            try
            {
                var t = session.GetTimelineProperties();
                Console.WriteLine($"    StartTime        : {t.StartTime}");
                Console.WriteLine($"    EndTime          : {t.EndTime}");
                Console.WriteLine($"    Position         : {t.Position}");
                Console.WriteLine($"    MinSeekTime      : {t.MinSeekTime}");
                Console.WriteLine($"    MaxSeekTime      : {t.MaxSeekTime}");
                Console.WriteLine($"    LastUpdatedTime  : {t.LastUpdatedTime:o}");
                Console.WriteLine($"    -> derived span  : {t.EndTime - t.StartTime}");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"    timeline failed: {ex.Message}");
            }

            try
            {
                var props = await session.TryGetMediaPropertiesAsync();
                Console.WriteLine($"    title            : '{props?.Title}'");
                Console.WriteLine($"    artist           : '{props?.Artist}'");
                Console.WriteLine($"    album            : '{props?.AlbumTitle}'");
                Console.WriteLine($"    track            : {props?.TrackNumber}/{props?.AlbumTrackCount}");
                Console.WriteLine($"    thumbnail        : {(props?.Thumbnail is null ? "<none>" : "present")}");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"    media properties failed: {ex.Message}");
            }
        }

        Console.WriteLine();
        Audio.Dump();
    }
}
