---
"@nestrix-js/nestjs": patch
"@nestrix-js/ui": patch
---

The Classes page no longer says "Method spans are off" for a service that exports method spans but has been idle longer than the selected window. `GET api/v1/classes` gains `methodsState` (`on`, `off` or `no-data-in-range`); `methodsEnabled` stays and is true unless the state is `off`. The standalone server reports `off` only when the service has never sent a method span within the data kept, and the page shows "No method spans from this service in the selected range" otherwise. The setup hint now also names `NestFactory.createApplicationContext` and `NestFactory.createMicroservice`.
