# Third-party notices

The JSON-RPC protocol of the Becker CentralControl (`cgi-bin/cc51rpc.cgi`,
methods `deviced.deviced_get_item_list`, `deviced.group_send_command`,
`deviced.group_get_state`, `deviced.item_get_state`, the cover and sensor types,
the move directions and the sensor ranges) was ported to JavaScript in `src/`
from Becker's own Home Assistant integration:

- **becker_centralcontrol_has**, version v.0.0.7 (2026-10-20),
  https://github.com/DominikStarke/becker_centralcontrol_has, MIT License:

```
MIT License

Copyright (c) 2024 Becker-Antriebe GmbH

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

No code of it is copied as is; its Becker relay headers (`gw.b-tronic.net`) and cookie are deliberately not reproduced.
