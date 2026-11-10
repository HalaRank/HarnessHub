# Desktop Phase 4 补充：GitHub 安装包分发

范围：用户要求 Windows App 也能通过 GitHub 直接下载安装包。版本维持 0.6.2，仅补齐本阶段发布与安装路径，不进入新产品阶段。

## 文件与行为

- `.github/workflows/desktop-windows.yml`：增加 `workflow_call`，复用原有固定工具链、NSIS/ZIP 构建、安装/卸载验证；Tag 必须匹配 package.json。上传路径固定到本次版本，防止 Actions 保留通配符版本目录后汇总路径错误，也不收集旧构建。缺少产物时失败。
- `.github/workflows/linux-release.yml`：显示名改为 HarnessHub release。手动运行构建两个平台并保存 artifact；版本 Tag 触发时等待两个平台成功，汇总并校验后创建一个 draft Release。仅 draft job 有 contents:write；打包器仍 publish:never。重复 Release 不覆盖。
- 上传资产包括 Windows exe/ZIP、`windows-x64-SHA256SUMS.txt`、`windows-x64-release-manifest.json`，及 Linux tar.gz、install.sh、SHA256SUMS.txt、release-manifest.json，共 8 个文件。Windows 元数据仅在汇总时改名，Linux 下载脚本依赖的名称保留。
- Release 正文直接链接当前 Tag 的 exe 和 ZIP，并说明同版本 WSL 后端要求。README、DESKTOP、DISTRIBUTION 补齐 GitHub 下载、PowerShell 校验、独立 WSL 后端安装、源码安装的区别和维护者流程；架构/实施文档记录本次授权。

不修改原生 Harness 配置、Workspace、ACP 权限或后台生命周期。Windows 包仍 unsigned，Windows 安装不代装 WSL/后端；无自动更新。已有工作区功能改动保留。

## 本地验证

日志见 [evidence/desktop-github-distribution](evidence/desktop-github-distribution/)。

- 直接读取工作流的 `Assemble and verify both platforms` Bash 步骤，在全新临时目录中对已有真实本地 Windows 0.6.2 unsigned 包和 Linux 0.6.2-verified 包执行：8 个资产齐全，Linux tar.gz/脚本/manifest 和 Windows exe/ZIP 的 SHA256 全部通过。临时目录及文件名保存至 `asset-assembly.json`。这些包是既有本地构建，本轮没有冒充从最终提交重新构建。
- 从 DESKTOP.md 提取 PowerShell 代码，在真实 Windows PowerShell 对已汇总的安装器和 Windows 校验文件执行校验部分，退出 0。未运行其最后一行 Start-Process，未安装到用户 Windows 环境。
- `bun run typecheck`：通过。
- `bun run lint`：通过。
- 工作流静态检查：两个 YAML 通过 SchemaStore GitHub Workflow schema；Linux 所有 Bash 步骤通过 `bash -n`。实际在 Windows PowerShell 执行版本步骤：v0.6.2 通过，v0.6.3 被拒绝。辅助验证脚本最初按 UTF-8 解码中文 PowerShell 错误而失败，改为保留输出字节后完成以上检查，未修改产品代码。actionlint 下载受 Go checksum 服务错误阻塞，未执行，不计为通过。
- `bun run test`：退出 0，119 项 Node 集成 + 121 项 TUI 测试通过，0 失败；实际编译 CLI/Daemon。
- `bun run desktop:test`：退出 0，61 项 Desktop 单元 + 16 项 Node 集成通过，0 失败；实际编译 Desktop。两个命令合计 317 项通过。
- `git diff --check`：通过。测试未发送真实模型 Prompt；未将 Mock ACP 回归当作真实 Harness 人工验收。

## 未验证与待验收

1. **未验证：远端 Actions 和 GitHub Release 公开下载。** 当前环境没有可调用的 GitHub 发布工具（gh 未安装），GitHub Releases API 只读查询返回 HTTP 403，不能据此判断远端是否已有公开包。本轮没有 commit、push、创建 Tag 或上传/发布 Release。
2. 维护者提交要发布的最终代码、推送版本匹配的 `v0.6.2` Tag，在 Actions 的 HarnessHub release 检查两个平台成功及 draft 的 8 个资产，然后发布 draft。在干净 Windows 用户环境从 Release 下载 exe/ZIP 和校验文件，按 DESKTOP 安装；所选 WSL2 发行版安装同 Release Linux 包，核对版本并连接。
3. 既有 Desktop Phase 4 签名、全新 Windows/WSL、物理 DPI/多屏/IME、重启恢复及真实 Harness 人工验收限制仍按原验收记录处理。本轮发布流程补充不追认这些项目通过。

参考：[GitHub 可复用工作流](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)、[upload-artifact 路径保留规则](https://github.com/actions/upload-artifact/tree/v4#upload-using-multiple-paths-and-exclusions)、[gh release create](https://cli.github.com/manual/gh_release_create)。已读取官方文档核对 workflow_call、通配符之后保留目录结构及 draft/verify-tag/notes-file 行为。

## 上传发布授权

用户随后明确要求“上传发布”，授权提交发布配置、推送版本 Tag、上传并公开发布 Release。重新检查发现现有 Git credential 可用于认证 GitHub API；先前匿名 API 的 HTTP 403 是共享出口未认证配额耗尽。已认证确认仓库有发布权限且尚无 Release。后续以最终提交的 Tag 运行构建/验证，不直接发布前述历史本地产物；实际远端结果另行补录。
