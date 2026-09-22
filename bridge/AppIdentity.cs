namespace SmtcBridge;

/// <summary>
/// Maps an SMTC source app id onto a display name and the process names that
/// own its audio.
///
/// SMTC identifies apps by AppUserModelID, which is a packaging artefact with
/// no supported mapping back to a process: Firefox reports a bare hash, Store
/// apps report a publisher-qualified family name, and Squirrel apps report a
/// reverse-DNS id that names a launcher rather than the process that actually
/// opens the audio stream. Per-app volume needs that process, so the common
/// players are listed explicitly and anything unknown falls back to deriving
/// candidates from the id itself.
/// </summary>
internal static class AppIdentity
{
    private static readonly (string[] Needles, string Name, string[] Processes)[] Known =
    [
        // Checked before "plex" so Plexamp is not swallowed by it.
        (["plexamp"], "Plexamp", ["Plexamp"]),
        (["spotify"], "Spotify", ["Spotify"]),
        // TIDAL's id names the shell; TIDALPlayer.exe owns the audio session.
        (["tidal"], "TIDAL", ["TIDAL", "TIDALPlayer"]),
        (["plex"], "Plex", ["Plex", "PlexHTPC", "Plex Media Player"]),
        (["msedge", "microsoft.edge"], "Edge", ["msedge"]),
        (["chrome"], "Chrome", ["chrome"]),
        // Firefox publishes a hash with nothing app-like in it at all.
        (["firefox", "308046b0af4a39cb"], "Firefox", ["firefox"]),
        (["zunemusic", "media.player"], "Media Player", ["Microsoft.Media.Player", "ZuneMusic"]),
        (["applemusic", "apple.music"], "Apple Music", ["AppleMusic"]),
        (["itunes"], "iTunes", ["iTunes"]),
        (["vlc"], "VLC", ["vlc"]),
        (["foobar"], "foobar2000", ["foobar2000"]),
        (["musicbee"], "MusicBee", ["MusicBee"]),
        (["winamp"], "Winamp", ["winamp"]),
        (["deezer"], "Deezer", ["Deezer"]),
        (["qobuz"], "Qobuz", ["Qobuz"]),
        (["roon"], "Roon", ["Roon", "RoonAppliance"])
    ];

    /// <summary>Something worth putting on a 200x100 LCD.</summary>
    public static string FriendlyName(string sourceAppId)
    {
        var lower = sourceAppId.ToLowerInvariant();
        foreach (var (needles, name, _) in Known)
        {
            foreach (var needle in needles)
            {
                if (lower.Contains(needle)) return name;
            }
        }

        var trimmed = sourceAppId;
        if (trimmed.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) trimmed = trimmed[..^4];

        // Store ids look like Publisher.App_hash!App; the segment before the
        // bang is the closest thing to a product name.
        var bang = trimmed.IndexOf('!');
        if (bang > 0) trimmed = trimmed[..bang];
        var underscore = trimmed.IndexOf('_');
        if (underscore > 0) trimmed = trimmed[..underscore];

        var parts = trimmed.Split('.', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length > 0 ? parts[^1] : trimmed;
    }

    /// <summary>
    /// Process names that may own this app's audio session, best first.
    ///
    /// Returns an exact list for known players. For anything else the id's own
    /// segments are used as candidates, with packaging noise removed - "com"
    /// and "squirrel" would otherwise prefix-match unrelated processes such as
    /// Squirrel's own updater.
    /// </summary>
    public static IReadOnlyList<string> ProcessHints(string sourceAppId)
    {
        var lower = sourceAppId.ToLowerInvariant();
        foreach (var (needles, _, processes) in Known)
        {
            foreach (var needle in needles)
            {
                if (lower.Contains(needle)) return processes;
            }
        }

        var candidates = new List<string>();
        foreach (var part in sourceAppId.Split(['.', '!', '\\', '/', '_'], StringSplitOptions.RemoveEmptyEntries))
        {
            if (part.Length < 3) continue;
            if (Noise.Contains(part)) continue;
            if (!candidates.Contains(part, StringComparer.OrdinalIgnoreCase)) candidates.Add(part);
        }
        return candidates;
    }

    private static readonly HashSet<string> Noise = new(StringComparer.OrdinalIgnoreCase)
    {
        "com", "org", "net", "exe", "app", "apps", "squirrel", "electron",
        "windows", "microsoft", "desktop", "player", "inc", "ltd", "llc"
    };

    /// <summary>
    /// Whether a running process plausibly belongs to this app.
    ///
    /// Prefix matching in both directions is what catches helper processes -
    /// TIDAL renders through TIDALPlayer.exe, and browsers play from a child
    /// renderer rather than the broker.
    /// </summary>
    public static bool Matches(IReadOnlyList<string> hints, string processName)
    {
        foreach (var hint in hints)
        {
            if (hint.Equals(processName, StringComparison.OrdinalIgnoreCase)) return true;
            if (hint.Length >= 3 && processName.StartsWith(hint, StringComparison.OrdinalIgnoreCase)) return true;
            if (processName.Length >= 3 && hint.StartsWith(processName, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }
}
