using System.Text.Json.Serialization;

namespace SmtcBridge;

/// <summary>
/// One line of stdout: the complete, current view of every media session.
///
/// The bridge pushes whole snapshots rather than deltas. Sessions appear and
/// vanish as apps start and stop, and SMTC fires overlapping change events for
/// a single user action, so reconciling deltas on the plugin side would cost
/// more than it saves. Art is the one exception - see <see cref="SessionPayload.Art"/>.
/// </summary>
internal sealed class StatePayload
{
    public string Type { get; set; } = "state";

    /// <summary>Session id Windows considers foremost, or null when nothing is loaded.</summary>
    public string? Current { get; set; }

    /// <summary>System render endpoint volume, 0..1.</summary>
    public double Volume { get; set; }

    public bool Muted { get; set; }

    public List<SessionPayload> Sessions { get; set; } = [];
}

internal sealed class SessionPayload
{
    /// <summary>The SMTC source app user model id, e.g. <c>com.squirrel.TIDAL.TIDAL</c>.</summary>
    public string Id { get; set; } = "";

    /// <summary>Best-effort friendly name derived from <see cref="Id"/>.</summary>
    public string App { get; set; } = "";

    public string Title { get; set; } = "";
    public string Artist { get; set; } = "";
    public string Album { get; set; } = "";
    public string AlbumArtist { get; set; } = "";
    public int TrackNumber { get; set; }

    /// <summary>playing | paused | stopped | changing | opened | closed | unknown</summary>
    public string Status { get; set; } = "unknown";

    public bool CanPlayPause { get; set; }
    public bool CanNext { get; set; }
    public bool CanPrev { get; set; }
    public bool CanSeek { get; set; }

    public long? PositionMs { get; set; }
    public long? DurationMs { get; set; }

    /// <summary>
    /// Unix ms at which <see cref="PositionMs"/> was sampled.
    ///
    /// SMTC only republishes the timeline every few seconds, so a progress bar
    /// driven straight off <see cref="PositionMs"/> moves in visible jumps. The
    /// plugin extrapolates from this stamp to animate smoothly between updates.
    /// </summary>
    public long PositionAt { get; set; }

    public double Rate { get; set; } = 1.0;

    /// <summary>Hash of the artwork bytes; null when the session has no art.</summary>
    public string? ArtId { get; set; }

    /// <summary>
    /// Artwork as a data URI, sent only when <see cref="ArtId"/> changes.
    ///
    /// Album art runs 40-200 KB, which is large enough that resending it on
    /// every playback tick would dominate the pipe. The plugin caches by
    /// <see cref="ArtId"/> and asks for a full resend via the refresh command.
    /// </summary>
    public string? Art { get; set; }

    /// <summary>Per-app volume 0..1 when an audio session could be matched.</summary>
    public double? AppVolume { get; set; }
}

internal sealed class LogPayload
{
    public string Type { get; set; } = "log";
    public string Level { get; set; } = "info";
    public string Message { get; set; } = "";
}

internal sealed class AckPayload
{
    public string Type { get; set; } = "ack";
    public int? Id { get; set; }
    public bool Ok { get; set; }
    public string? Error { get; set; }
}

/// <summary>A command line read from stdin.</summary>
internal sealed class CommandPayload
{
    public int? Id { get; set; }
    public string Cmd { get; set; } = "";

    /// <summary>Target session id. When absent the current session is used.</summary>
    public string? Target { get; set; }

    public double? Value { get; set; }
    public double? Delta { get; set; }
    public long? PositionMs { get; set; }

    /// <summary>"system" or "app" for volume commands.</summary>
    public string? Scope { get; set; }
}

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(StatePayload))]
[JsonSerializable(typeof(LogPayload))]
[JsonSerializable(typeof(AckPayload))]
[JsonSerializable(typeof(CommandPayload))]
internal partial class BridgeJsonContext : JsonSerializerContext;
