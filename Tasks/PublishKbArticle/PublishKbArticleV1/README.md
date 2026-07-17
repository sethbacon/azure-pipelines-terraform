# Publish KB Article to ServiceNow

### Overview

Publishes or updates a knowledge base article in ServiceNow — create, update, workflow-state transition, and image-attachment sync (content-hash-based idempotency).

### Known limitation: MathML and SVG foreign content is rejected

As a mutation-XSS (mXSS) hardening measure, the pre-publish HTML security gate **rejects** article content that contains MathML (`<math>`, `<annotation-xml>`) or SVG foreign-content elements (`<foreignObject>`, `<mglyph>`, `<malignmark>`). These are HTML-integration points that can smuggle active content past a sanitizer. The check **fails closed** and is not lifted by the `force` input, which only bypasses the content-loss heuristic and never the security checks.

Real-world SVG exports from tools such as mermaid and draw.io use `<foreignObject>` to embed HTML labels, so such diagrams are rejected. Export diagrams using plain SVG `<text>` elements instead of `<foreignObject>` HTML labels.
