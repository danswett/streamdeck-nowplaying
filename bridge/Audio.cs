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

    /// <summary>AudioSessionState::AudioSessionStateExpired.</summary>
    private const int SessionExpired = 2;

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

    /// <summary>
    /// System endpoint level, reported for diagnostics only.
    ///
    /// Nothing writes to the endpoint: the dial drives the displayed player's
    /// mixer entry instead, and there is intentionally no setter here so that
    /// cannot regress.
    /// </summary>
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

    // -- per-app session ----------------------------------------------------

    /// <summary>Volume and mute for one app's mixer entry.</summary>
    public readonly record struct AppAudio(double Volume, bool Muted);

    /// <summary>
    /// The app's entry in the Windows volume mixer, or null when it has none.
    ///
    /// Null is a real answer, not an error: a player that has released its
    /// audio stream genuinely has no mixer entry, and the mixer UI shows
    /// nothing for it either.
    /// </summary>
    public static AppAudio? GetApp(string sourceAppId)
    {
        AppAudio? result = null;
        ForEachMatch(sourceAppId, volume =>
        {
            if (volume.GetMasterVolume(out var level) != 0) return false;
            volume.GetMute(out var muted);
            result = new AppAudio(level, muted);
            return true;
        }, stopOnFirst: true);
        return result;
    }

    public static bool SetApp(string sourceAppId, double value)
    {
        var target = (float)Math.Clamp(value, 0, 1);
        var context = Guid.Empty;
        // Applied to every matching session: browsers and Electron players
        // often hold more than one, and setting only the first would leave the
        // app half-adjusted.
        return ForEachMatch(sourceAppId, volume => volume.SetMasterVolume(target, ref context) == 0, stopOnFirst: false);
    }

    public static bool SetAppMute(string sourceAppId, bool muted)
    {
        var context = Guid.Empty;
        return ForEachMatch(sourceAppId, volume => volume.SetMute(muted, ref context) == 0, stopOnFirst: false);
    }

    /// <summary>
    /// Visits the render sessions belonging to an app.
    /// </summary>
    /// <returns>True when at least one visit succeeded.</returns>
    private static bool ForEachMatch(string sourceAppId, Func<ISimpleAudioVolume, bool> visit, bool stopOnFirst)
    {
        var hints = AppIdentity.ProcessHints(sourceAppId);
        if (hints.Count == 0) return false;

        var any = false;
        try
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            if (enumerator.GetDefaultAudioEndpoint(ERender, EMultimedia, out var device) != 0) return false;

            var iid = AudioSessionManager2Iid;
            if (device.Activate(ref iid, ClsCtxAll, IntPtr.Zero, out var raw) != 0) return false;

            var manager = (IAudioSessionManager2)raw;
            if (manager.GetSessionEnumerator(out var sessions) != 0) return false;
            if (sessions.GetCount(out var count) != 0) return false;

            for (var i = 0; i < count; i++)
            {
                if (sessions.GetSession(i, out var session) != 0) continue;
                if (session is not IAudioSessionControl2 control) continue;

                // Expired sessions are gone from the mixer UI too; acting on
                // one would silently do nothing.
                if (control.GetState(out var sessionState) == 0 && sessionState == SessionExpired) continue;
                if (control.GetProcessId(out var pid) != 0 || pid == 0) continue;

                string name;
                try
                {
                    using var process = Process.GetProcessById((int)pid);
                    name = process.ProcessName;
                }
                catch
                {
                    // Exited between enumeration and lookup.
                    continue;
                }

                if (!AppIdentity.Matches(hints, name)) continue;
                if (session is not ISimpleAudioVolume volume) continue;

                if (visit(volume))
                {
                    any = true;
                    if (stopOnFirst) break;
                }
            }
        }
        catch (Exception ex)
        {
            Fault("ForEachMatch", ex);
        }

        return any;
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
