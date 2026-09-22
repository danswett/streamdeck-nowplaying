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
    /// <param name="Exclusive">
    /// True when the endpoint hosting this app is held in WASAPI exclusive
    /// mode. Its mixer entry still exists and still accepts writes - the value
    /// even reads back - but nothing it does reaches the speakers.
    /// </param>
    public readonly record struct AppAudio(double Volume, bool Muted, bool Exclusive);

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
        ForEachMatch(sourceAppId, (volume, device) =>
        {
            if (volume.GetMasterVolume(out var level) != 0) return false;
            volume.GetMute(out var muted);
            result = new AppAudio(level, muted, IsEndpointExclusive(device));
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
        return ForEachMatch(sourceAppId, (volume, _) => volume.SetMasterVolume(target, ref context) == 0, stopOnFirst: false);
    }

    public static bool SetAppMute(string sourceAppId, bool muted)
    {
        var context = Guid.Empty;
        return ForEachMatch(sourceAppId, (volume, _) => volume.SetMute(muted, ref context) == 0, stopOnFirst: false);
    }

    /// <summary>
    /// Visits the render sessions belonging to an app.
    /// </summary>
    /// <returns>True when at least one visit succeeded.</returns>
    private static bool ForEachMatch(string sourceAppId, Func<ISimpleAudioVolume, IMMDevice, bool> visit, bool stopOnFirst)
    {
        var hints = AppIdentity.ProcessHints(sourceAppId);
        if (hints.Count == 0) return false;

        var any = false;
        try
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();

            // Every active endpoint, not just the default one: a player
            // configured to output to a specific device holds its mixer entry
            // there, and adjusting the default endpoint's copy would change
            // nothing audible.
            if (enumerator.EnumAudioEndpoints(ERender, DeviceStateActive, out var devices) != 0) return false;
            devices.GetCount(out var deviceCount);

            for (uint d = 0; d < deviceCount && !(any && stopOnFirst); d++)
            {
                if (devices.Item(d, out var device) != 0) continue;

                var iid = AudioSessionManager2Iid;
                if (device.Activate(ref iid, ClsCtxAll, IntPtr.Zero, out var raw) != 0) continue;

                var manager = (IAudioSessionManager2)raw;
                if (manager.GetSessionEnumerator(out var sessions) != 0) continue;
                if (sessions.GetCount(out var count) != 0) continue;

                for (var i = 0; i < count; i++)
                {
                    if (sessions.GetSession(i, out var session) != 0) continue;
                    if (session is not IAudioSessionControl2 control) continue;

                    // Expired sessions are gone from the mixer UI too; acting
                    // on one would silently do nothing.
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

                    if (visit(volume, device))
                    {
                        any = true;
                        if (stopOnFirst) break;
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Fault("ForEachMatch", ex);
        }

        return any;
    }

    // -- exclusive mode ------------------------------------------------------

    private const int ShareModeShared = 0;
    private const int DeviceInUse = unchecked((int)0x8889000A);
    private static readonly Guid AudioClientIid = new("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");

    /// <summary>
    /// Cached per endpoint. Opening a client is cheap but not free, and the
    /// answer cannot change without an app starting or stopping playback.
    /// </summary>
    private static readonly Dictionary<string, (bool Exclusive, long At)> ExclusiveCache = new(StringComparer.OrdinalIgnoreCase);

    private const long ExclusiveTtlMs = 4000;

    /// <summary>
    /// Whether an endpoint is currently held in WASAPI exclusive mode.
    ///
    /// Detected rather than inferred: while one app owns an endpoint
    /// exclusively, any other app's shared-mode
    /// <c>IAudioClient::Initialize</c> fails with AUDCLNT_E_DEVICE_IN_USE.
    /// The alternative - noticing that the endpoint meter reads zero while a
    /// player claims to be playing - would misfire on a quiet passage or the
    /// gap between tracks.
    ///
    /// The client is initialised and dropped, never started, so this does not
    /// disturb anything that is playing.
    /// </summary>
    private static bool IsEndpointExclusive(IMMDevice device)
    {
        string id;
        try
        {
            if (device.GetId(out id) != 0) return false;
        }
        catch
        {
            return false;
        }

        lock (Gate)
        {
            if (ExclusiveCache.TryGetValue(id, out var cached) && Environment.TickCount64 - cached.At < ExclusiveTtlMs)
            {
                return cached.Exclusive;
            }
        }

        var exclusive = Probe(device);

        lock (Gate) ExclusiveCache[id] = (exclusive, Environment.TickCount64);
        return exclusive;
    }

    private static bool Probe(IMMDevice device)
    {
        var format = IntPtr.Zero;
        try
        {
            var iid = AudioClientIid;
            if (device.Activate(ref iid, ClsCtxAll, IntPtr.Zero, out var raw) != 0) return false;
            if (raw is not IAudioClient client) return false;
            if (client.GetMixFormat(out format) != 0) return false;

            var hr = client.Initialize(ShareModeShared, 0, 0, 0, format, IntPtr.Zero);
            return hr == DeviceInUse;
        }
        catch (Exception ex)
        {
            Fault("ExclusiveProbe", ex);
            return false;
        }
        finally
        {
            if (format != IntPtr.Zero) Marshal.FreeCoTaskMem(format);
        }
    }

    // -- diagnostics --------------------------------------------------------

    private const int DeviceStateActive = 0x1;
    private static readonly string[] SessionStates = ["Inactive", "Active", "Expired"];

    /// <summary>
    /// Prints every active render endpoint and the sessions on it.
    ///
    /// Deliberately enumerates all endpoints, not just the default: a player
    /// configured to output to a specific device holds its mixer entry there,
    /// and adjusting the default endpoint's copy would do nothing audible.
    /// </summary>
    public static void Dump()
    {
        Console.WriteLine("=== Audio render endpoints ===");
        try
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();

            var defaultId = "";
            if (enumerator.GetDefaultAudioEndpoint(ERender, EMultimedia, out var preferred) == 0)
            {
                preferred.GetId(out defaultId);
            }

            if (enumerator.EnumAudioEndpoints(ERender, DeviceStateActive, out var devices) != 0)
            {
                Console.WriteLine("  EnumAudioEndpoints failed");
                return;
            }

            devices.GetCount(out var deviceCount);
            for (uint i = 0; i < deviceCount; i++)
            {
                if (devices.Item(i, out var device) != 0) continue;
                device.GetId(out var id);
                var marker = string.Equals(id, defaultId, StringComparison.OrdinalIgnoreCase) ? "*" : " ";
                var mode = Probe(device) ? "  [EXCLUSIVE MODE IN USE]" : "";
                Console.WriteLine($"{marker} {DeviceName(device)}{mode}");
                Console.WriteLine($"    {id}");

                var iid = AudioSessionManager2Iid;
                if (device.Activate(ref iid, ClsCtxAll, IntPtr.Zero, out var raw) != 0)
                {
                    Console.WriteLine("      <cannot activate session manager>");
                    continue;
                }

                var manager = (IAudioSessionManager2)raw;
                if (manager.GetSessionEnumerator(out var sessions) != 0) continue;
                if (sessions.GetCount(out var count) != 0) continue;
                if (count == 0) Console.WriteLine("      <no sessions>");

                for (var j = 0; j < count; j++)
                {
                    if (sessions.GetSession(j, out var session) != 0) continue;
                    if (session is not IAudioSessionControl2 control) continue;

                    control.GetState(out var state);
                    control.GetProcessId(out var pid);

                    var name = "<unknown>";
                    try
                    {
                        using var process = Process.GetProcessById((int)pid);
                        name = process.ProcessName;
                    }
                    catch
                    {
                        if (pid == 0) name = "<system sounds>";
                    }

                    var level = "?";
                    var muted = "?";
                    if (session is ISimpleAudioVolume volume)
                    {
                        if (volume.GetMasterVolume(out var value) == 0) level = value.ToString("0.00");
                        if (volume.GetMute(out var flag) == 0) muted = flag.ToString();
                    }

                    var label = state >= 0 && state < SessionStates.Length ? SessionStates[state] : state.ToString();
                    Console.WriteLine($"      pid={pid,-7} {name,-22} state={label,-9} vol={level} mute={muted}");
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"  enumeration failed: {ex.GetType().Name}: {ex.Message}");
        }
    }

    private static string DeviceName(IMMDevice device)
    {
        try
        {
            if (device.OpenPropertyStore(0, out var store) != 0) return "<unnamed>";
            // PKEY_Device_FriendlyName
            var key = new PropertyKey
            {
                FormatId = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"),
                PropertyId = 14
            };
            if (store.GetValue(ref key, out var value) != 0) return "<unnamed>";
            // VT_LPWSTR
            return value.Type == 31 && value.Pointer != IntPtr.Zero
                ? Marshal.PtrToStringUni(value.Pointer) ?? "<unnamed>"
                : "<unnamed>";
        }
        catch
        {
            return "<unnamed>";
        }
    }

    // -- COM ----------------------------------------------------------------

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumerator;

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int Item(uint index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey
    {
        public Guid FormatId;
        public int PropertyId;
    }

    /// <summary>
    /// Enough of PROPVARIANT to read a string property.
    ///
    /// The union starts at offset 8 on x64; only VT_LPWSTR is read, so the
    /// remaining members are left undeclared rather than modelled.
    /// </summary>
    [StructLayout(LayoutKind.Explicit)]
    private struct PropVariant
    {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public IntPtr Pointer;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
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

    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioMeterInformation
    {
        [PreserveSig] int GetPeakValue(out float peak);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity,
            IntPtr format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint frames);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    // -- volume effectiveness test -------------------------------------------

    private static readonly Guid AudioMeterIid = new("C02216F6-8C67-4B5B-9D00-D008E73E0064");

    /// <summary>
    /// Measures whether per-app volume actually reaches the speakers.
    ///
    /// Setting a session's volume can succeed while changing nothing audible -
    /// an app rendering in WASAPI exclusive mode bypasses the mixer entirely,
    /// and some apps reassert their own level. Reading the endpoint's peak
    /// meter before and after settles it without anyone having to judge by ear.
    /// </summary>
    public static void TestEffectiveness(string sourceAppId, double probeLevel)
    {
        Console.WriteLine($"=== Per-app volume effectiveness: {sourceAppId} ===");

        var before = Audio.GetApp(sourceAppId);
        if (before is null)
        {
            Console.WriteLine("  no mixer entry for this app; nothing to test");
            return;
        }
        Console.WriteLine($"  current level : {before.Value.Volume:0.00} (muted={before.Value.Muted})");

        var meter = EndpointMeter();
        if (meter is null)
        {
            Console.WriteLine("  endpoint meter unavailable");
            return;
        }

        var baseline = SamplePeak(meter, 2200);
        Console.WriteLine($"  peak @ {before.Value.Volume:0.00}   : {baseline:0.0000}");
        if (baseline < 0.0005)
        {
            Console.WriteLine("  WARNING: no audio detected. Is it playing, and on this endpoint?");
        }

        SetApp(sourceAppId, probeLevel);
        System.Threading.Thread.Sleep(400);
        var lowered = SamplePeak(meter, 2200);
        Console.WriteLine($"  peak @ {probeLevel:0.00}   : {lowered:0.0000}");

        SetApp(sourceAppId, before.Value.Volume);
        Console.WriteLine($"  restored to   : {before.Value.Volume:0.00}");

        if (baseline < 0.0005)
        {
            Console.WriteLine("  RESULT: inconclusive (silence)");
            return;
        }

        var ratio = lowered / baseline;
        var expected = probeLevel / Math.Max(before.Value.Volume, 0.0001);
        Console.WriteLine($"  observed ratio: {ratio:0.000}   expected ~{expected:0.000}");
        Console.WriteLine(
            ratio < expected * 2.0
                ? "  RESULT: per-app volume IS reaching the output"
                : "  RESULT: per-app volume is NOT affecting the output (exclusive mode, or the app overrides it)");
    }

    /// <summary>
    /// Samples the peak level of every active render endpoint.
    ///
    /// Locates where audio is actually going. A session can be listed as
    /// Active on one endpoint while the sound leaves by another, and an
    /// exclusive-mode stream bypasses the shared engine entirely, leaving
    /// every shared meter reading zero.
    /// </summary>
    public static void Meters(int milliseconds)
    {
        Console.WriteLine($"=== Endpoint peak levels over {milliseconds}ms ===");
        try
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();

            var defaultId = "";
            if (enumerator.GetDefaultAudioEndpoint(ERender, EMultimedia, out var preferred) == 0)
            {
                preferred.GetId(out defaultId);
            }

            if (enumerator.EnumAudioEndpoints(ERender, DeviceStateActive, out var devices) != 0) return;
            devices.GetCount(out var deviceCount);

            var meters = new List<(string Name, string Id, IAudioMeterInformation Meter)>();
            for (uint i = 0; i < deviceCount; i++)
            {
                if (devices.Item(i, out var device) != 0) continue;
                device.GetId(out var id);
                var iid = AudioMeterIid;
                if (device.Activate(ref iid, ClsCtxAll, IntPtr.Zero, out var raw) != 0) continue;
                if (raw is IAudioMeterInformation meter) meters.Add((DeviceName(device), id, meter));
            }

            var peaks = new float[meters.Count];
            var until = Environment.TickCount64 + milliseconds;
            while (Environment.TickCount64 < until)
            {
                for (var i = 0; i < meters.Count; i++)
                {
                    if (meters[i].Meter.GetPeakValue(out var value) == 0 && value > peaks[i]) peaks[i] = value;
                }
                System.Threading.Thread.Sleep(20);
            }

            var any = false;
            for (var i = 0; i < meters.Count; i++)
            {
                if (peaks[i] < 0.0005) continue;
                any = true;
                var marker = string.Equals(meters[i].Id, defaultId, StringComparison.OrdinalIgnoreCase) ? "*" : " ";
                Console.WriteLine($"{marker} {peaks[i]:0.0000}  {meters[i].Name}");
            }

            if (!any)
            {
                Console.WriteLine("  no endpoint shows any signal.");
                Console.WriteLine("  Either nothing is playing, or the stream is in WASAPI exclusive mode,");
                Console.WriteLine("  which bypasses the shared mixer - and with it per-app volume.");
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"  meter scan failed: {ex.GetType().Name}: {ex.Message}");
        }
    }

    private static IAudioMeterInformation? EndpointMeter()
    {
        try
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            if (enumerator.GetDefaultAudioEndpoint(ERender, EMultimedia, out var device) != 0) return null;
            var iid = AudioMeterIid;
            if (device.Activate(ref iid, ClsCtxAll, IntPtr.Zero, out var raw) != 0) return null;
            return raw as IAudioMeterInformation;
        }
        catch
        {
            return null;
        }
    }

    private static float SamplePeak(IAudioMeterInformation meter, int milliseconds)
    {
        var peak = 0f;
        var until = Environment.TickCount64 + milliseconds;
        while (Environment.TickCount64 < until)
        {
            if (meter.GetPeakValue(out var value) == 0 && value > peak) peak = value;
            System.Threading.Thread.Sleep(25);
        }
        return peak;
    }
}
