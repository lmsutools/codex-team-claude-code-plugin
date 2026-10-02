# Offline reviewer configuration inspection

Inspected the installed `@openai/codex` package offline (2026-09-28), version **0.157.1**.

Binary: `C:/Users/User/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`.

A byte-string search found `project_doc_max_bytes` 23 times, including the configuration field sequence `model_providersproject_doc_max_bytesproject_doc_fallback_filenames`. The reviewer now passes `-c project_doc_max_bytes=0`.

Searches found no occurrences of `ignore_project_config`, `disable_project_config`, or `project_config_enabled`. This does not prove that no other override exists; it does not establish a reliable way to disable every project configuration layer. We therefore use the lead-authorized fallback as well: any change to AGENTS.md, AGENTS.override.md or .codex inputs prevents the reviewer call and creates an incomplete packet with the reason. Ignored instructions are included; missing or overflowed baselines fail closed. The same changes gate automatic host verification. No package was installed, no network was used, and no trust or sandbox setting was bypassed.
