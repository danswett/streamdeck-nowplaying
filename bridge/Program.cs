using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace SmtcBridge;

/// <summary>
/// Newline-delimited JSON bridge between the Stream Deck plugin and the
/// Windows media stack.
///
/// The plugin runs on the Node runtime Stream Deck ships, so anything native
/// loaded in-process would be pinned to that runtime's ABI. Keeping the
/// Windows work in a separate executable sidesteps that entirely, and means a
/// crash here degrades the dial instead of taking the plugin down.
///
/// stdout carries protocol frames only; diagnostics go to stderr.
/// </summary>
internal static class Program
{
    private static readonly SemaphoreSlim WriteGate = new(1, 1);
    private static StreamWriter _out = null!;
    private static Watcher _watcher = null!;

    /// <summary>Coalesces bursts of SMTC events into one frame.</summary>
    private const int DebounceMs = 70;

    /// <summary>
    /// Raised to request a frame. Capacity of one makes it a latch rather than
    /// a queue, so a spinning dial cannot build a backlog of repaints.
    /// </summary>
    private static readonly SemaphoreSlim Signal = new(0, 1);

    private static string _lastSignature = "";

    private static async Task<int> Main(string[] args)
    {
        _out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };

        WatchParent(args);

        try
        {
            _watcher = new Watcher();
            await _watcher.StartAsync();
        }
        catch (Exception ex)
        {
            await WriteAsync(new LogPayload { Level = "error", Message = $"SMTC unavailable: {ex.Message}" });
            return 1;
        }

        if (args.Contains("--diagnose"))
        {
            await Diagnostics.RunAsync();
            return 0;
        }

        if (args.Contains("--meters"))
        {
            Audio.Meters(4000);
            return 0;
        }

        if (args.Contains("--voltest"))
        {
            var target = _watcher.Resolve(null);
            if (target is null) Console.WriteLine("no current session");
            else Audio.TestEffectiveness(target, 0.25);
            return 0;
        }

        if (args.Contains("--once"))
        {
            await WriteAsync(await _watcher.SnapshotAsync());
            return 0;
        }

        _watcher.Changed += Schedule;

        await EmitAsync(force: true);

        using var shutdown = new CancellationTokenSource();
        var pump = PumpAsync(shutdown.Token);

        // SMTC does not raise events for endpoint volume, and position only
        // republishes every few seconds, so a slow tick keeps both honest.
        using var heartbeat = new Timer(_ => Schedule(), null, 1000, 1000);

        // Reading stdin to EOF is the shutdown signal: Stream Deck closes the
        // pipe when it stops the plugin, and without this the sidecar would
        // outlive it and keep a second copy running on the next launch.
        while (true)
        {
            string? line;
            try { line = await Console.In.ReadLineAsync(); }
            catch { break; }
            if (line is null) break;
            if (string.IsNullOrWhiteSpace(line)) continue;

            await DispatchAsync(line);
        }

        await shutdown.CancelAsync();
        try { await pump; } catch (OperationCanceledException) { }

        _watcher.Dispose();
        return 0;
    }

    /// <summary>
    /// Exits when the host process does.
    ///
    /// Closing stdin is the normal shutdown signal, but a host terminated
    /// abruptly - as Stream Deck does when it stops a plugin, and as a test
    /// harness does when it kills one - can leave EOF unobserved. An orphaned
    /// sidecar goes unnoticed while holding COM subscriptions to every media
    /// session, and they accumulate one per restart.
    /// </summary>
    private static void WatchParent(string[] args)
    {
        var index = Array.IndexOf(args, "--parent");
        if (index < 0 || index + 1 >= args.Length) return;
        if (!int.TryParse(args[index + 1], out var pid)) return;

        try
        {
            var parent = Process.GetProcessById(pid);
            parent.EnableRaisingEvents = true;
            parent.Exited += (_, _) => Environment.Exit(0);

            // Covers the parent dying between spawn and this subscription.
            if (parent.HasExited) Environment.Exit(0);
        }
        catch (ArgumentException)
        {
            // No such process: it is already gone.
            Environment.Exit(0);
        }
    }

    // -- emission -----------------------------------------------------------

    private static void Schedule()
    {
        // Release throws once the latch is already set, which is exactly the
        // coalescing behaviour wanted: the pending frame will pick up the
        // newer state when it runs.
        try { Signal.Release(); }
        catch (SemaphoreFullException) { }
    }

    /// <summary>
    /// Emits frames on demand, never faster than the debounce window.
    ///
    /// Rotating a dial generates events far faster than a 200x100 LCD can
    /// usefully be repainted, and every frame is a round trip through Stream
    /// Deck, so the pump absorbs the burst and paints the settled state.
    /// </summary>
    private static async Task PumpAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                await Signal.WaitAsync(token);
                await Task.Delay(DebounceMs, token);

                // Drain signals raised during the window so they do not cause
                // a redundant second pass.
                while (Signal.CurrentCount > 0) await Signal.WaitAsync(token);

                await EmitAsync();
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private static async Task EmitAsync(bool force = false)
    {
        try
        {
            var state = await _watcher.SnapshotAsync();

            // Position advances on its own, so it is excluded from the change
            // test; the plugin extrapolates between frames. Without this the
            // heartbeat would repaint the LCD every second while idle.
            var signature = Signature(state);
            var playing = state.Sessions.Any(s => s.Status == "playing");
            if (!force && signature == _lastSignature && !playing) return;
            _lastSignature = signature;

            await WriteAsync(state);
        }
        catch (Exception ex)
        {
            await WriteAsync(new LogPayload { Level = "warn", Message = $"snapshot failed: {ex.Message}" });
        }
    }

    private static string Signature(StatePayload state)
    {
        var builder = new StringBuilder();
        builder.Append(state.Current).Append('|')
               .Append(Math.Round(state.Volume, 4)).Append('|')
               .Append(state.Muted).Append('|');
        foreach (var s in state.Sessions)
        {
            builder.Append(s.Id).Append('~')
                   .Append(s.Title).Append('~')
                   .Append(s.Artist).Append('~')
                   .Append(s.Album).Append('~')
                   .Append(s.Status).Append('~')
                   .Append(s.ArtId).Append('~')
                   .Append(s.DurationMs).Append('~')
                   .Append(s.CanNext).Append(s.CanPrev).Append(s.CanPlayPause).Append('~')
                   .Append(s.AppVolume is null ? "-" : Math.Round(s.AppVolume.Value, 4).ToString()).Append('~')
                   .Append(s.AppMuted is null ? "-" : s.AppMuted.Value.ToString())
                   .Append(';');
        }
        return builder.ToString();
    }

    private static async Task WriteAsync<T>(T payload)
    {
        var json = payload switch
        {
            StatePayload state => JsonSerializer.Serialize(state, BridgeJsonContext.Default.StatePayload),
            LogPayload log => JsonSerializer.Serialize(log, BridgeJsonContext.Default.LogPayload),
            AckPayload ack => JsonSerializer.Serialize(ack, BridgeJsonContext.Default.AckPayload),
            _ => null
        };
        if (json is null) return;

        await WriteGate.WaitAsync();
        try { await _out.WriteLineAsync(json); }
        catch { /* pipe closed; the read loop will notice */ }
        finally { WriteGate.Release(); }
    }

    // -- commands -----------------------------------------------------------

    private static async Task DispatchAsync(string line)
    {
        CommandPayload? command;
        try { command = JsonSerializer.Deserialize(line, BridgeJsonContext.Default.CommandPayload); }
        catch (JsonException ex)
        {
            await WriteAsync(new LogPayload { Level = "warn", Message = $"bad command: {ex.Message}" });
            return;
        }
        if (command is null) return;

        var ok = false;
        string? error = null;

        try
        {
            switch (command.Cmd)
            {
                case "refresh":
                    _watcher.ResetArtCache();
                    await EmitAsync(force: true);
                    ok = true;
                    break;

                case "toggle": ok = await _watcher.ToggleAsync(command.Target); break;
                case "play": ok = await _watcher.PlayAsync(command.Target); break;
                case "pause": ok = await _watcher.PauseAsync(command.Target); break;
                case "next": ok = await _watcher.NextAsync(command.Target); break;
                case "prev": ok = await _watcher.PreviousAsync(command.Target); break;

                case "seek":
                    ok = command.PositionMs is { } position && await _watcher.SeekAsync(command.Target, position);
                    break;

                case "volume": ok = AdjustAppVolume(command); break;
                case "setVolume": ok = SetAppVolume(command); break;
                case "mute": ok = SetAppMute(command); break;

                case "ping": ok = true; break;

                default:
                    error = $"unknown command '{command.Cmd}'";
                    break;
            }
        }
        catch (Exception ex)
        {
            error = ex.Message;
        }

        if (command.Id is not null) await WriteAsync(new AckPayload { Id = command.Id, Ok = ok, Error = error });

        // Transport and volume changes are reflected back immediately rather
        // than waiting for the heartbeat, so the LCD tracks the dial.
        if (ok && command.Cmd is not ("ping" or "refresh")) Schedule();
    }

    /// <summary>
    /// Adjusts the mixer entry of the app the dial is displaying.
    ///
    /// There is deliberately no fallback to the system endpoint. A dial
    /// captioned with one player quietly moving the machine's master volume is
    /// worse than doing nothing, and the failed ack lets the plugin say so on
    /// the LCD instead.
    /// </summary>
    private static bool AdjustAppVolume(CommandPayload command)
    {
        var delta = command.Delta ?? 0;
        if (delta == 0) return false;

        var target = _watcher.Resolve(command.Target);
        if (target is null) return false;

        var current = Audio.GetApp(target);
        if (current is null) return false;

        return Audio.SetApp(target, current.Value.Volume + delta);
    }

    private static bool SetAppVolume(CommandPayload command)
    {
        var target = _watcher.Resolve(command.Target);
        if (target is null) return false;
        if (Audio.GetApp(target) is null) return false;
        return Audio.SetApp(target, command.Value ?? 0);
    }

    /// <summary>Mutes the app's mixer entry; with no value, toggles it.</summary>
    private static bool SetAppMute(CommandPayload command)
    {
        var target = _watcher.Resolve(command.Target);
        if (target is null) return false;

        var current = Audio.GetApp(target);
        if (current is null) return false;

        var muted = command.Value is null ? !current.Value.Muted : command.Value > 0.5;
        return Audio.SetAppMute(target, muted);
    }
}
