# DaxART SVG Plotter Optimizer Web

Server-side SVG optimizer for dense contour maps. Python standard library only.

- Preserves original SVG page signature (width, height, viewBox, preserveAspectRatio).
- Processes dense linear SVG paths server-side.
- Generates lightweight previews separately from full output.
- Temporary files are stored in ephemeral `/tmp` and expire automatically.