# Native media app design

The apps follow the BMW canvas interaction model: a stable left rail, four large
16:9 video tiles per row, two title lines, controller focus, and large playback controls.
Existing BMW/Ubuntu font atlases, including Cyrillic, travel with each source package.

The palette is charcoal `#121820`, surfaces `#202A36`, readable white `#F5F7FA`,
secondary text `#AEBACA`, with VK blue `#0077FF` or RUTUBE red `#F02F43` for focus
and actions. Service identity comes from the accent and a separate launcher entry.

The three rail actions are Search, Videos and Account. Public browsing never starts
authentication. RUTUBE's public home is a catalogue; VK starts with a search invitation,
without presenting a keyword search as personal recommendations. Account setup/errors
appear only in Account. A long VK OAuth URL is not replaced by a Google device URL.

Safety is fail-closed by default, with the same optional latch as the YouTube app:
`Parked.watch(..., {strict:true})` hides video whenever speed is unknown, stale, or moving,
unless the "video_driving" setting was switched on while parked (arm-on-park only; switching
it off while moving hides the picture at once). The instrument cluster never gets video while
moving. Audio and playback controls remain available in every case.

`build_apps.py` copies these shared UI sources into the two independent source apps.
`--source-only` omits BMW SDK files entirely; the Store uses the car's own SDK.
