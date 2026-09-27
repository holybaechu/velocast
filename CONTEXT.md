# Velocast

Velocast renders browser animations into videos by seeking to explicit frames.

## Language

**Composition**: A named animation with dimensions, a frame rate, a duration in
frames, and a page or element to render.

**Composition metadata**: The dimensions, timing, and page or element selection
that describe a composition. Metadata alone does not supply animation behavior.

**Frame adapter**: An animation integration that exposes a composition's duration
and seeks its animation to a requested frame.

**Render job**: A request to render a composition or page selection with specified
output, encoding, and execution settings.

**Render plan**: The frame assignments, output locations, and ordered encoder
choices for a render job, resolved from the request and observed capabilities.

**Render workspace**: The temporary files owned by a render job until its output
has passed verification and is published, or the job fails and removes them.

**Frame schedule**: The ordered frame numbers assigned to a render operation.

**Segment**: A contiguous range of composition frames encoded separately for
assembly into the final video.

**Encoded-frame lifecycle**: The capture, conversion, encoding, and accounting of
scheduled frames, ending in completion or failure cleanup.

**Renderer runtime**: A native renderer together with the supporting runtime files
and environment needed to launch it.

**Verified artifact**: A released native renderer distribution whose contents and
compatibility metadata have passed the release manifest's verification rules.
