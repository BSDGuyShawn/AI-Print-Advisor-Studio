# Security

## Reporting a problem

Please **don't** post security problems in public issues. Use GitHub's private reporting instead: **[Report a vulnerability](https://github.com/jtroberts83/AI-Print-Advisor-Studio/security/advisories/new)**. You'll get an answer as soon as possible, and credit if you'd like it.

## What the app does and doesn't do

- **Runs locally.** It shows its own built-in pages only; it never loads websites inside the app.
- **Talks to:**
  - `api.anthropic.com`, only when you click an AI button, with your own API key;
  - your **printers** on your home network (addresses you enter or that it finds on your network);
  - a filament brand's **online store**, only when you click "Find missing photos online", to fetch a product photo.
- **Stores** settings, filament and history in `%APPDATA%\AI 3D Print Advisor Studio`. API keys (Anthropic and printers) are encrypted with Windows' own protection (Electron `safeStorage` / DPAPI) and never written to logs, backups or exports.
- **No telemetry**, analytics, ads or auto-updates.

## Automated checks on this repository

| Check | What it does | When |
|---|---|---|
| **CodeQL** | GitHub's static analysis for security bugs in the JavaScript | every push, pull request, and weekly |
| **Dependency audit** | `npm audit` and **OSV-Scanner** check the app's libraries against known vulnerabilities (CVEs) | every push, pull request, and weekly |
| **Dependabot** | Opens updates for vulnerable or outdated libraries and workflow actions | weekly |
| **Secret scan** | **Gitleaks** looks for passwords, keys and tokens anywhere in the history | every push and pull request |
| **Release scan** | Every release zip is scanned with **ClamAV** (antivirus), and its **SHA-256 checksums** and the scan report are attached to the release | when a release is published |

Results are public under the **[Actions](https://github.com/jtroberts83/AI-Print-Advisor-Studio/actions)** and **[Security](https://github.com/jtroberts83/AI-Print-Advisor-Studio/security)** tabs.

## Checking a download yourself

1. On the release page, open `SHA256SUMS.txt`.
2. In the folder with your download, open PowerShell (Shift + right-click → "Open PowerShell window here") and run:
   ```powershell
   Get-FileHash .\AI-3D-Print-Advisor-Studio-2.18.0-win-x64.zip
   ```
3. The long code it prints must match the line for that file in `SHA256SUMS.txt`. If it doesn't, don't run it: the file was changed or damaged.

You can also upload the zip to [VirusTotal](https://www.virustotal.com/) to have it checked by dozens of antivirus engines.

## Known limitations

- The Windows program isn't **code-signed** yet, so Windows SmartScreen warns on first start ("Windows protected your PC").
- The app runs on **Electron 45**, using Electron's own published Windows build (its checksum is checked before each release is built). Dependabot proposes Electron updates as they come out.
