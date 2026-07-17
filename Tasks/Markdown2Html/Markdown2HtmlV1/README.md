# Markdown to HTML Converter

### Overview

Converts Markdown files to HTML for publishing as ServiceNow knowledge base articles — parses YAML front matter, renders via `markdown-it` with `highlight.js` syntax highlighting, and resolves `{% include %}`-style file includes.

### Known limitation: MathML and SVG foreign content is removed

As a mutation-XSS (mXSS) hardening measure, the HTML sanitizer **removes** MathML content (`<math>`, `<annotation-xml>`) and SVG foreign-content elements (`<foreignObject>`, `<mglyph>`, `<malignmark>`) from the rendered output, along with anything nested inside them. These are HTML-integration points that can smuggle active content past a sanitizer.

Real-world SVG exports from tools such as mermaid and draw.io use `<foreignObject>` to embed HTML labels, so those labels are stripped during conversion. If diagram text must survive conversion, export diagrams using plain SVG `<text>` elements instead of `<foreignObject>` HTML labels.
