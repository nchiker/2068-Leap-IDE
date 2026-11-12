# Prototype sizes re-measured 2026-11-12 on main 0a453b9 (after MUSIC M5); code bytes, prototype switches (no `ret`: its patch was lost)

| switch | runner | vaults | platformer | shooter | blockfall | breakout | bounce | total |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| code bytes now | 9893 | 13513 | 9059 | 11376 | 11449 | 1505 | 465 | 57260 |
| hl | -135 | -141 | -135 | -72 | -111 | -15 | -3 | -612 |
| jr | -230 | -225 | -192 | -120 | -155 | -21 | -8 | -951 |
| cmpc | -367 | -453 | -354 | -297 | -260 | -77 | -33 | -1841 |
| sel | -219 | -207 | -179 | -63 | -84 | 0 | 0 | -752 |
| arr | -463 | -992 | -808 | -1440 | -522 | 0 | 0 | -4225 |
| hl,jr,cmpc,sel | -959 | -1035 | -873 | -572 | -633 | -122 | -49 | -4243 |
| hl,jr,cmpc,sel,arr | -1386 | -2022 | -1660 | -1991 | -1125 | -122 | -49 | -8355 |
