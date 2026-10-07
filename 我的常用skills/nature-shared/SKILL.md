---
name: nature-shared
description: 内部共享参考支持包，供已安装的 nature-writing、nature-polishing、nature-reader、nature-paper2ppt 技能调用。不要将其作为独立的用户工作流触发；仅按其他 Nature 技能的要求加载指定的 core 或 journal-format 文件。
---

# Nature Shared References

Use this package only as a dependency of another installed Nature skill.

- Load the exact referenced file; do not preload the whole package.
- Treat `core/` and `journal-formats/` as shared definitions, not standalone workflows.
- Return to the requesting skill for task logic, output format, and final QA.
