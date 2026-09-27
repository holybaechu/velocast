# Agent composition checks

`velocast check <compositionId>` opens the built composition in a real local
Chrome or Edge session. It requires a local `entry` and `renderer.snapshotRoot`;
the same frozen input boundary used for rendering supplies the report's
`sessionId` and SHA-256 `sourceVersion`.

Without `--frames`, the command samples the first, middle, and last frame. Supply
a comma-separated list for transition boundaries. `--snapshots <directory>`
writes the browser pixels inspected at each frame.

Assertions use this shape:

```json
{
  "selectors": [
    {
      "selector": ".headline",
      "visible": true,
      "insideComposition": true,
      "noClipping": true,
      "minContrast": 4.5,
      "motion": {
        "fromFrame": 30,
        "toFrame": 45,
        "minPixels": 24,
        "maxPixels": 120
      }
    }
  ]
}
```

Every selector result includes its exact frame and seconds, match state,
visibility, bounding box, composition containment, clipping ancestors, and
contrast when measurable. Motion is the Euclidean distance between bounding-box
origins at its two exact frames. A missing selector or unmeasurable required
value fails the assertion. Page scroll dimensions beyond the composition
viewport and browser runtime errors also fail the check.

The command also examines up to 200 visible direct-text elements per frame
without configuration. It reports the examined/candidate count, truncation,
unmeasurable contrast count, stable selector, nearest `data-velocast-source`
annotation, bounding box, and common clipping/bounds/contrast findings. These
automatic findings are warnings by default because authored edge clipping can
be intentional. Pass `--strict` to make them fail the check. Explicit
assertions always fail when their requirements are unmet.

Contrast is reported as unmeasurable when the element-to-opaque-ancestor chain
uses a CSS image, gradient, or opacity. Images behind sibling elements may also
make the computed color insufficient. DOM rectangles do not interpret pixels in
canvas, WebGL, filters, masks, or shadows. Motion distance does not grade easing
or animation quality. Review the optional screenshots for these cases.

Set `VELOCAST_BROWSER_BINARY` or pass `--browser` when browser auto-discovery is
not suitable. The command creates an isolated temporary browser profile and
removes it when the check finishes.
