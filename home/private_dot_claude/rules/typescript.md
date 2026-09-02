---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.mts"
  - "**/*.cts"
  - "**/*.mjs"
  - "**/*.cjs"
---
- Use strict TypeScript; avoid `any` — prefer `unknown` with type guards
- Prefer `const` over `let`; never use `var`
- Use prettier for formatting (auto-format hook handles this)
- Match existing test framework in the project (jest, vitest, or node:test)

## Comments and JSDoc (TypeScript and JavaScript)

Adapted from the *Comments and documentation* section of Google's TypeScript style guide
(<https://google.github.io/styleguide/tsguide.html#comments-and-documentation>) and
sections 4.8 and 7 of Google's JavaScript style guide
(<https://google.github.io/styleguide/jsguide.html#jsdoc>). The shared rules are in
`comments.md`. The two guides agree except where marked *JS only* or *TS only*.

- **`/** JSDoc */` for users of the code, `//` for the code itself.** Tools read JSDoc;
  only people read `//`. Never write an implementation note in `/** */`.
- **Document every top-level export of a module,** every class, interface, enum and
  typedef, and every public method and function. A description is optional on a
  constructor and on a private property whose name and type say enough.
- **General form:** `/**` and `*/` on their own lines with aligned ` *` prefixes. A block
  that fits on one line may be `/** This short jsdoc describes the function. */`; one that
  overflows must use the multi-line form.
- **JSDoc is Markdown.** A list is a Markdown list with a blank line before it; indented
  plain text is collapsed by the extractor.
- **Each tag on its own line,** tag first, and a tag carrying data (`@param`, `@return`)
  is never combined with another. Simple flag tags (`@private`, `@const`, `@final`,
  `@export`) may share a line. A wrapped tag continuation indents four spaces.
- **A method description is a third-person verb phrase:** "Operates on an instance of
  MyClass and returns something."
- **A multi-line implementation comment is `//` on each line,** indented with the code.
  *TS only:* `/* */` is not used for multi-line comments. *JS only:* `/* */` with aligned `*`
  is also acceptable. Never box a comment.
- **Name an opaque argument at the call site** with `/* name= */` before the value:
  `someFunction(obviousParam, /* shouldRender= */ true, /* name= */ 'hello')`.
- **JSDoc goes above a decorator,** with no blank line between decorator and symbol.
- *TS only:* **omit what the type system already says.** No types in `@param` or
  `@return`, no `@override`, and no comment that restates a signature. A comment earns its
  place by adding rationale or context.
- *JS only:* **types live in JSDoc, in braces:** `@param {number} arg`, `@return {!Array<TYPE>}`,
  `@type {number}`. Nullability is explicit on a reference type (`!Foo` non-null, `?Foo`
  nullable) and omitted on a primitive, which is non-null by default. Always give template
  parameters (`!Array<string>`, never bare `!Array`). An overriding method carries
  `@override` with every `@param` and `@return` restated. A file may open with
  `@fileoverview`.
- **TODO:** `// TODO: <link> - <explanation>`.
