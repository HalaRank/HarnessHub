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

首轮远端运行 `42780279640` 暴露 Windows filtered install 后从仓库根执行 Bun 会加载 Linux TUI 的 `@opentui/solid/preload`，而该依赖刻意未安装。改为从已有 Desktop bunfig 所在目录执行版本检查和打包；本地同命令版本检查、Desktop build、4 项 release 边界测试通过。发布工作流增加显式已有 Tag 的手动重建输入，两个平台均 checkout 该 Tag，Linux 验证版本后才创建 draft；保留已推送 Tag，不移动或覆盖它。

## GitHub v0.6.2 已公开发布

2026-11-10 08:25:42 UTC（Asia/Shanghai 2026-11-10 16:25:42），用户授权后已公开发布 [HarnessHub v0.6.2](https://github.com/HalaRank/HarnessHub/releases/tag/v0.6.2)，共 8 个资产。`releases/latest` 实际解析到此版本。CLI/Windows app 版本仍为 0.6.2，Windows unsigned；不是对未完成物理平台/真实模型验收的追认。

远端 [Actions 42780879784](https://github.com/HalaRank/HarnessHub/actions/runs/42780879784) **success**：Windows 构建 exe/ZIP、4 项发布边界测试、实际安装/启动/重装/异常退出/卸载保留验证与 artifact 上传成功；Linux typecheck/lint/全量测试/构建/隔离发行安装验收成功；draft 汇总与两平台校验成功。首轮有失败 Windows job 的旧运行已取消，不计为通过。

应用源码来自不可变 `v0.6.2` Tag 提交 `4bb7ef37bd0ffa28fd6902ce1debb5d80c4da98b`。执行修复后的工作流定义来自 main 提交 `9e5be78bd88f1a139beec415b1011a3945fa9280`；两个平台明确 checkout 原 Tag。Linux manifest 实读 `sourceCommit` 匹配、`sourceDirty=false`，随包 Node 24.18.0/Bun 1.4.4。没有上传旧的本地验收包，也没有移动 Tag。

发布前已从 GitHub 下载两个平台校验文件和 manifest，核对元数据自身 SHA256、全部安装包/脚本/manifest 与 GitHub 资产 digest 一致。公开后已匿名下载 Windows 校验文件和 Linux install.sh，与发布前核验内容完全相同。续查再次确认两文件匿名 HTTP 200、内容未变，且 `releases/latest` 返回 HTTP 200 并解析到 v0.6.2；具体大小、SHA256 与复查时间见 [匿名下载记录](evidence/desktop-github-distribution/release-v0.6.2/public-download-verification.json)。发布证据见 [release-v0.6.2](evidence/desktop-github-distribution/release-v0.6.2/)。

| 文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| Windows setup.exe | 110813562 | `b9fa7edd5eb45e1baf442ad47c1445f85e8a6d3cef456d84f07b0f3050784771` |
| Windows ZIP | 153517161 | `323baf152e70727564f6ff68eab58ba2f0346df8696e382b86418c109744f415` |
| Linux tar.gz | 428448032 | `7c8e76bac7f573fab10a81461d3dd2ef32e0bbca9ec98ad4be06e79ad16dde9f` |

2026-11-10 08:38:42 UTC 已完成 Windows 安装器公开下载复核。网络多次超时及 TLS EOF 后，以断点续传和校验 Content-Range 的匿名 HTTP 206 分段补齐；最终对完整 110813562 字节文件计算 SHA256，结果与公开 `windows-x64-SHA256SUMS.txt` 及 GitHub 资产 digest 同时一致。不是仅校验下载样本或元数据；详情见 [完整安装器校验](evidence/desktop-github-distribution/release-v0.6.2/public-installer-verification.json)。本次没有在用户 Windows 环境运行该安装器。

本次文档收尾检查：`bun run lint` 通过；8 个资产记录、已保存校验文件/Windows manifest 的大小及 SHA256、两平台校验条目与资产 digest、Linux sourceCommit/sourceDirty 一致性检查通过；公开下载证据与完整安装器再次核对通过；发布文档 `git diff --check` 通过。未重新运行产品测试；远端构建及安装测试结果见本节 Actions 记录。

前述“未验证：远端 Actions/公开下载”是首轮实施结束时的历史状态，已由本节的实际结果更新。干净 Windows/WSL 从公开包全流程、物理硬件、真实登录模型等未验证项仍保持未验证。
