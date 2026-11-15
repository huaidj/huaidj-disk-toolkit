# Licensing and component boundaries

HuaiDJ Disk Toolkit is licensed under **GPL-3.0-or-later**:

- The original JavaScript/PowerShell bridge, CLI/MCP interface, skills,
  documentation and development scripts are GPL-3.0-or-later.
- Rufus source, changes derived from Rufus, the native adapter patch and the
  modified Rufus native executable are GPL-3.0-or-later. Upstream component
  notices remain applicable.

The bridge launches the native executable as a separate process. This
implementation boundary does not change the project's licensing choice:
both the original toolkit and Rufus-derived engine are offered under
GPL-3.0-or-later. Third-party MIT/Apache/BSD and other compatible notices
remain applicable to their respective components.

Rufus's `src/rufus.c` explicitly permits GPL version 3 or, at the recipient's
option, a later version. The full GPLv3 text is preserved verbatim in
`docs/licenses/GPL-3.0.txt` and the Rufus source tree.

The [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.en.html#MereAggregation)
discusses separate programs, process communication and aggregation. A
process boundary alone does not decide every possible derivative-work
question. The project uses one GPL3+ license for its own code and the
Rufus-derived engine to make distribution and recipient rights clear.

## Distribution rules

1. Keep copyright headers and third-party notices intact.
2. Mark the native engine as a modified HuaiDJ build, with the actual change
   date and source revision in its source/build records.
3. Preserve the pinned upstream revision, complete native patch, build
   scripts and toolchain instructions. GPL-covered changes remain GPL3+.
4. When distributing the native binary, supply its exact Corresponding
   Source with that release. A pointer to an unrelated upstream version is
   not the source of the modified executable.
5. Keep a source/binary manifest with SHA-256 hashes. This records identity;
   it does not claim byte-for-byte reproducible compiler output.
6. Do not impose additional restrictions on the GPL-covered software.

The [GPLv3 license](https://www.gnu.org/licenses/gpl-3.0.en.html), especially
sections 1, 5 and 6, describes Corresponding Source and conveyance terms.
Each recipient receives the applicable license texts with the package.
