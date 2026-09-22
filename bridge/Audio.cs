using System.Diagnostics;
using System.Runtime.InteropServices;

namespace SmtcBridge;

/// <summary>
/// Core Audio interop, used for both the system render endpoint and per-app
/// session volume.
///
/// SMTC has no volume concept of its own - it only carries transport controls -
/// so turning the dial has to reach WASAPI directly.
/// </summary>
internal static class Audio
{
    private static readonly Guid AudioEndpointVolumeIid = new("5CDF2C82-841E-4546-9722-0CF74078229A");
    private static readonly Guid AudioSessionManager2Iid = new("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");

    private const int ERender = 0;
    private const int EMultimedia = 1;
    private const int ClsCtxAll = 23;

    private static IAudioEndpointVolume? _endpoint;
    private static readonly Lock Gate = new();

    /// <summary>
    /// Last interop failure, surfaced on stderr.
    ///
    /// Core Audio failing is otherwise silent - volume simply reads zero - and
    /// the cause is usually environmental (a trimmed build stripping COM
    /// marshalling, or no render endpoint present), so the reason matters more
    /// than the symptom.
    /// </summary>
    private static string? _lastFault;

    private static void Fault(string stage, Exception ex)
    {
        var message = $"{stage}: {ex.GetType().Name}: {ex.Message}";
        if (message == _lastFault) return;
        _lastFault = message;
        try { Console.Error.WriteLine($"[audio] {message}"); } catch { }
    }

    // -- system endpoint ----------------------------------------------------

    private static IAudioEndpointVolume? Endpoint()
    {
        lock (Gate)
        {
            if (_endpoint is not null) return _endpoint;
            try
            {
                var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
                var hr = enumerator.GetDefaultAudioEndpoint(ERender, EMultimedia, out var device);
                if (hr != 0)
                {
                    Fault("GetDefaultAudioEndpoint", new InvalidOperationException($"hr=0x{hr:X8}"));
                    return null;
                }

                var iid = AudioEndpointVolumeIid;
                hr = device.Activate(ref iid, ClsCtxAll, IntPtr.Zero, out var raw);
                if (hr != 0)
                {
                    Fault("Activate(IAudioEndpointVolume)", new InvalidOperationException($"hr=0x{hr:X8}"));
                    return null;
                }

                _endpoint = (IAudioEndpointVolume)raw;
                return _endpoint;
            }
            catch (Exception ex)
            {
                Fault("Endpoint", ex);
                return null;
            }
        }
    }

    /// <summary>Drops the cached endpoint so the next call re-resolves it.</summary>
    private static void Invalidate()
    {
        lock (Gate) { _endpoint = null; }
    }

    public static (double Volume, bool Muted) GetSystem()
    {
        try
        {
            var endpoint = Endpoint();
            if (endpoint is null) return (0, false);
            endpoint.GetMasterVolumeLevelScalar(out var level);
            endpoint.GetMute(out var muted);
            return (level, muted);
        }
        catch (Exception ex)
        {
            // Default device changes invalidate the interface pointer.
            Fault("GetSystem", ex);
            Invalidate();
            return (0, false);
        }
    }

    public static bool SetSystem(double value)
    {
        try
        {
            var endpoint = Endpoint();
            if (endpoint is null) return false;
            var ctx = Guid.Empty;
            return endpoint.SetMasterVolumeLevelScalar((float)Math.Clamp(value, 0, 1), ref ctx) == 0;
        }
        catch
        {
            Invalidate();
            return false;
        }
    }

    public static bool SetSystemMute(bool muted)
    {
        try
        {
            var endpoint = Endpoint();
            if (endpoint is null) return false;
            var ctx = Guid.Empty;
            return endpoint.SetMute(muted, ref ctx) == 0;
        }
        catch
        {
            Invalidate();
            return false;
        }
    }

    // -- per-app session ----------------------------------------------------

    /// <summary>
    /// Volume of the audio sessions belonging to an SMTC source app, or null
    /// when nothing matched.
    /// </summary>
    public static double? GetApp(string sourceAppId)
    {
        foreach (var volume in MatchingSessions(sourceAppId))
        {
            if (volume.GetMasterVolume(out var level) == 0) return level;
        }
        return null;
    }

    public static bool SetApp(string sourceAppId, double value)
    {
        var target = (float)Math.Clamp(value, 0, 1);
        var ctx = Guid.Empty;
        var any = false;
        foreach (var volume in MatchingSessions(sourceAppId))
        {
            if (volume.SetMasterVolume(target, ref ctx) == 0) any = true;
        }
        return any;
    }

    /// <summary>
    /// Every render session whose owning process plausibly belongs to
    /// <paramref name="sourceAppId"/>.
    ///
    /// SMTC identifies apps by AppUserModelID, which has no supported mapping
    /// back to a process, so the match is heuristic: compare the id's segments
    /// against process names, allowing either to be a prefix of the other.
    /// Prefix matching is what catches helper processes - TIDAL reports
    /// <c>com.squirrel.TIDAL.TIDAL</c> but renders audio from TIDALPlayer.exe,
    /// and browsers play from a child renderer, not the broker.
    /// </summary>
    private static List<ISimpleAudioVolume> MatchingSessions(string sourceAppId)
    {
        var matches = new List<ISimpleAudioVolume>();
        var tokens = Tokens(sourceAppId);
        if (tokens.Count == 0) return matches;

        try
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            if (enumerator.GetDefaultAudioEndpoint(ERender, EMultimedia, out var device) != 0) return matches;

            var iid = AudioSessionManager2Iid;
            if (device.Activate(ref iid, ClsCtxAll, IntPtr.Zero, out var raw) != 0) return matches;

            var manager = (IAudioSessionManager2)raw;
            if (manager.GetSessionEnumerator(out var sessions) != 0) return matches;
            if (sessions.GetCount(out var count) != 0) return matches;

            for (var i = 0; i < count; i++)
            {
                if (sessions.GetSession(i, out var control) != 0) continue;
                if (control is not IAudioSessionControl2 control2) continue;
                if (control2.GetProcessId(out var pid) != 0 || pid == 0) continue;

                string name;
                try
                {
                    using var process = Process.GetProcessById((int)pid);
                    name = process.ProcessName;
                }
                catch
                {
                    continue;
                }

                if (!Matches(tokens, name)) continue;
                if (control is ISimpleAudioVolume volume) matches.Add(volume);
            }
        }
        catch
        {
            // Enumeration races with apps starting and stopping; a miss simply
            // means the caller falls back to system volume.
        }

        return matches;
    }

    private static List<string> Tokens(string sourceAppId)
    {
        var parts = sourceAppId.Split(['.', '!', '\\', '/', '_'], StringSplitOptions.RemoveEmptyEntries);
        var tokens = new List<string>();
        foreach (var part in parts)
        {
            var token = part.Equals("exe", StringComparison.OrdinalIgnoreCase) ? null : part;
            // "com", "squirrel" and friends are packaging noise that would
            // otherwise prefix-match unrelated processes.
            if (token is null || token.Length < 3) continue;
            if (token is "com" or "App" or "Apps") continue;
            if (!tokens.Contains(token, StringComparer.OrdinalIgnoreCase)) tokens.Add(token);
        }
        return tokens;
    }

    private static bool Matches(List<string> tokens, string processName)
    {
        foreach (var token in tokens)
        {
            if (token.Equals(processName, StringComparison.OrdinalIgnoreCase)) return true;
            if (processName.Length >= 3 && token.StartsWith(processName, StringComparison.OrdinalIgnoreCase)) return true;
            if (token.Length >= 3 && processName.StartsWith(token, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    // -- COM ----------------------------------------------------------------

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumerator;

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int access, out IntPtr properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioEndpointVolume
    {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
        [PreserveSig] int GetChannelCount(out uint count);
        [PreserveSig] int SetMasterVolumeLevel(float level, ref Guid context);
        [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context);
        [PreserveSig] int GetMasterVolumeLevel(out float level);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
        [PreserveSig] int SetChannelVolumeLevel(uint channel, float level, ref Guid context);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
        [PreserveSig] int GetChannelVolumeLevel(uint channel, out float level);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
        [PreserveSig] int GetVolumeStepInfo(out uint step, out uint stepCount);
        [PreserveSig] int VolumeStepUp(ref Guid context);
        [PreserveSig] int VolumeStepDown(ref Guid context);
        [PreserveSig] int QueryHardwareSupport(out uint mask);
        [PreserveSig] int GetVolumeRange(out float min, out float max, out float increment);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
        [PreserveSig] int RegisterSessionNotification(IntPtr notification);
        [PreserveSig] int UnregisterSessionNotification(IntPtr notification);
        [PreserveSig] int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr duck);
        [PreserveSig] int UnregisterDuckNotification(IntPtr duck);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
    }

    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl2
    {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid context);
        [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
        [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid context);
        [PreserveSig] int GetGroupingParam(out Guid group);
        [PreserveSig] int SetGroupingParam(ref Guid group, ref Guid context);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr notification);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr notification);
        [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetProcessId(out uint pid);
        [PreserveSig] int IsSystemSoundsSession();
        [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ISimpleAudioVolume
    {
        [PreserveSig] int SetMasterVolume(float level, ref Guid context);
        [PreserveSig] int GetMasterVolume(out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }
}
