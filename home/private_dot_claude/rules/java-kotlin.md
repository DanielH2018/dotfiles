---
paths:
  - "**/*.java"
  - "**/*.kt"
  - "**/*.kts"
---
- Use the project's Gradle wrapper (`./gradlew`), never bare `gradle`
- Tests use JUnit 5 + AssertJ; colocated in `src/test/`
- Follow Google Java Style; ktfmt for Kotlin
- Prefer `val` over `var` in Kotlin; use data classes for DTOs
- Never catch `Exception` or `Throwable` without rethrowing — catch specific types
- Database operations use transactions explicitly; no autocommit assumptions

## Comments, Javadoc and KDoc

Adapted from sections 4.8.6 and 7 of Google's Java style guide
(<https://google.github.io/styleguide/javaguide.html#s7-javadoc>) and the *Documentation*
section of Google's Kotlin style guide
(<https://developer.android.com/kotlin/style-guide#documentation>). The shared rules are in
`comments.md`.

- **Javadoc or KDoc is required on every public class or type,** every public member (and
  `protected` members in Kotlin), and every record component. Two exceptions: a
  self-explanatory member such as `getFoo()`, unless a reader needs a term explained; and
  a method overriding a supertype method.
- **Whenever an implementation comment would describe purpose or behaviour, write it as a
  doc comment instead** (`/** ... */`), even where one is not required.
- **General form:** `/**` on its own line, each line prefixed by an aligned ` *`, closing
  `*/` on its own line. A block with no tags that fits on one line may be `/** Returns the
  customer ID. */`.
- **The first line is a summary fragment,** a noun or verb phrase capitalised and
  punctuated as a sentence, not a full sentence: `/** Returns the customer ID. */`. Not
  "A {@code Foo} is a...", not "This method returns...", not the imperative "Save the
  record."
- **Paragraphs:** one blank ` *` line between them and before the first tag. In Java, each
  paragraph after the first starts with `<p>` directly against its first word; block-level
  HTML such as `<ul>` takes no `<p>`. KDoc is Markdown and needs no `<p>`.
- **Tag order.** Java: `@param`, `@return`, `@throws`, `@deprecated`. Kotlin:
  `@constructor`, `@receiver`, `@param`, `@property`, `@return`, `@throws`, `@see`. No tag
  appears with an empty description. A continuation line indents four spaces from the `@`.
- **Block comments** use `/* ... */` or `//`, indented with the code, later lines of a
  `/* */` block starting with an aligned `*`. Prefer `/* ... */` for a multi-line comment a
  formatter should re-wrap; formatters leave `//` blocks alone. A copyright or licence
  header is `/* */`, never `/** */` or `//`.
- **An end-of-line `//` has one space on each side** of the slashes.
- **TODO:** `// TODO: <link> - <explanation>`, for example
  `// TODO: crbug.com/12345678 - Remove this after the 2047q4 compatibility window expires.`
