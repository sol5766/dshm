# node-addon-system flock

`flock.c` is vendored from
`@deepseek-ai/node-addon-system@0.1.2/src/flock.c` (BSD-3-Clause).

It is built into the shared `hostruntime` HSP as `libsystem.so`. The core tree
contains only a placeholder `system.node`; the host native-redirect loads this
library from the HSP. Vendoring the source makes clean builds independent of
`dist/core/work`, which is a disposable build tree and may not exist when the
HSP is configured.
