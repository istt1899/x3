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

Safety is stricter than the optional legacy override: `Parked.watch(..., {strict:true})`
is required and video is hidden whenever speed is unknown, stale, or moving. Audio
and playback controls remain available. There is no video-while-driving switch.

`build_apps.py` copies these shared UI sources into the two independent source apps.
`--source-only` omits BMW SDK files entirely; the Store uses the car's own SDK.
