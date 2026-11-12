---
"@nestrix-js/nestjs": patch
"@nestrix-js/ui": patch
---

Large job traces (thousands of spans) made the standalone server's Overview and Classes slow; own time is now computed in one pass with a new index, and children on a host with a slightly slow clock are no longer missed. The route explain endpoint also loads at most 200,000 spans per side.
