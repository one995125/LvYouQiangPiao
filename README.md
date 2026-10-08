# 拾景 · 景区官方购票入口聚合小程序

按省份浏览景区榜单（热度 / 游客量 / 评分 / 门票价格排序），把想去的景区收进可搜索的私人收藏库，自动保留浏览历史，并用“我的旅行地图”记录去过/想去的省份与景区；支持查看已核验的官方服务入口、加入私人行程，以及阅读由拾景管理员整理发布的出行资料与预约提示。普通用户投稿及点赞功能已关闭。

> 平台只做官方入口聚合，不参与售票，用户所有操作不产生任何费用。

## 技术栈

原生微信小程序 · TypeScript · Less · TDesign Miniprogram · 微信云开发

## 快速开始

1. 微信开发者工具打开项目根目录（已配置 `miniprogramRoot` 与 `cloudfunctionRoot`）。
2. 若 TDesign 组件报缺失：菜单【工具 → 构建 npm】。
3. 当前 AppID 为 `wx2e5899c27aa6dd48`，云环境为 `cloud1-d4gfatip0edd01506`；编译前请确认当前微信开发者账号拥有这两项资源的权限。

## 景区收藏库

- 底部「收藏」是独立主入口；首页和「我的」也可直达。按景区名、城市搜索，区分景区/攻略，支持最近/最早收藏排序和每次 24 条增量展示。
- 收藏页直接读取已有本机/云同步快照，不会为每条收藏并发查询景区。点开条目时才读取景区最新资料；即使景区暂时无法读取，收藏条目本身仍可查看和取消。
- 沿用现有 `shijing_user_data` 同步协议和删除墓碑，不迁移、重建或覆盖历史收藏。当前云函数每类数据最多接收 500 条；新版客户端在收藏达到 500 条时阻止继续添加，避免云端静默裁剪。将来若需超过 500 条，应先设计分页的逐条收藏存储和数据迁移，不直接提高这个数字。

## 浏览历史

- 景区详情成功读取后自动记录浏览历史；同一景区重复浏览只更新时间并置顶，最多保留最近 200 处。底层字段仍为 `footprints`，不迁移、不丢旧数据。
- 「我的 → 浏览历史」按浏览时间倒序展示轻量景区快照，点击后再读取景区最新资料，不会为列表逐条并发查询。
- 一键清空会同步 `footprintClearedAt` 水位；多设备冲突合并时，清空前的旧记录不会被另一台设备重新带回。旧版 v2 客户端未提交该字段时，云函数保留现有浏览历史，避免更新收藏或行程时误覆盖。

## 我的旅行地图

- 首页卡片只加载 34 个省份质心 `data/province-centroids.js`，按真实经纬度绘制点阵和进度，不会把约 399KB 的省界几何带入主包。完整地图位于 `packageExtra/pages/travel-map`，且只有该分包页会读取 `packageExtra/data/china-map.js`。
- 地图使用 34 个省级行政区 SVG path、南海诸岛内嵌框和 10 段九段线；底图当前仅作示意并明确标注“非标准地图”。发布正式地图能力前，应替换为有审图号的标准地图服务数据并同步更新声明。
- 省份可手动标记“去过/想去”，两种状态互斥；景区详情也可标记，成功后自动点亮所属省份。四类状态使用独立上限：省份各 34、景区各 500；景区裁剪与取消均保留独立删除墓碑。
- 旅行地图字段作为可选字段加入现有同步 v2。云函数以字段是否存在决定是否参与合并，旧客户端未提交时保留云端现值；客户端继续使用 `baseRevision`、事务、校时时间、墓碑与“先拉基线后上传”的原有保护。

## 首页个性化回流

- 首页“继续看看”直接读取 `getFootprints()` 的本地轻量快照，按 `visitedAt` 倒序、按景区去重，最多显示最近 4 处。点击后才进入原景区详情页；首页不会为了补齐名称、封面或时间再请求景区列表/详情。
- “也许你会喜欢”只从首页当前已经加载到 `feature/rest` 的景区对象中选择，按足迹省份和已收藏/已浏览景区的可确认分类进行本机打分，排除已经收藏或浏览过的景区，最多展示 2 处。
- 推荐和最近浏览都是纯本地派生数据，不写 storage、不改变同步 revision，也不触发登录或云函数。没有足迹、没有可靠偏好或没有合适候选时，整个对应模块不渲染，不显示空白卡片或骨架。

## 云开发配置

当前项目与「记得」小程序共用 `cloud1-d4gfatip0edd01506`。为避免覆盖共享环境中的其他项目，拾景所有后端资源都使用 `shijing` 命名空间。

1. 环境 ID 位于 `miniprogram/constants/config.ts`：
   ```ts
   export const CLOUD_ENV_ID = 'cloud1-d4gfatip0edd01506'
   ```
2. 右键 `cloudfunctions/` 下每个云函数 →【上传并部署：云端安装依赖】：`shijingLogin`、`shijingUserData`、`shijingReminder`、`shijingTripShare`、`shijingGuide`、`shijingInitData`、`shijingCorrection`、`shijingAdmin`、`shijingLog`。
3. 在云数据库创建集合并设置权限：

   | 集合 | 用途 | 权限建议 |
   | --- | --- | --- |
   | `shijing_scenics` | 景区 | 所有用户可读，客户端不可写 |
   | `shijing_guides` | 编辑整理攻略及保留的历史投稿 | 线上已核验为 `ADMINONLY`；公开读取和本人历史数据管理统一走云函数 |
   | `shijing_users` | 用户资料 | 客户端不可直接读写，统一走云函数 |
   | `shijing_user_data` | 收藏、浏览历史、旅行地图与行程 | 客户端不可直接读写，统一走云函数 |
   | `shijing_guide_likes` | 保留的历史点赞记录 | 客户端不可直接读写；不再新增 |
   | `shijing_corrections` | 景区资料纠错 | 客户端不可直接读写，统一走云函数 |
   | `shijing_reminders` | 行程提醒登记 | 客户端不可直接读写，按云函数上下文 OpenID 隔离 |
   | `shijing_reminder_logs` | 提醒发送幂等与结果日志 | 客户端不可读写，仅云函数访问 |

   建议索引：`shijing_scenics`: `province + heat / visitors / rating / price`；`shijing_guides`: `status + official + createdAt`、`scenicId`、`_openid + createdAt`；`shijing_corrections`: `_openid + dayKey`、`status + createdAt`；`shijing_reminders`: `active + tripReminderDate`、`active + releaseReminderDate`。
4. 在当前小程序内登录后，到「我的 → 关于与免责声明」点击复制自己的 OpenID。再在云开发控制台分别为 `shijingInitData`、`shijingAdmin`、`shijingGuide` 配置环境变量 `ADMIN_OPENIDS=<管理员在当前小程序下的openid>`（多名管理员用英文逗号分隔），并确认配置生效。三者未配置时默认拒绝管理操作。管理员再次打开关于页后可见景区和攻略维护入口；普通用户不可见，云函数也会再次校验身份。不要把 OpenID 当作前端写死的管理员凭证。
5. 首次初始化只补充云端缺失的景区与攻略，同 ID 的已有资料不会覆盖。进入「资料维护中心」可编辑预约规则、官方渠道、资料来源和临时公告。攻略进入「维护拾景攻略」后先保存为草稿，再单独发布；已发布内容可编辑、下架，均以 `contentRevision` 检查冲突。下架不删除文档，但公开列表、详情和旧分享链接均无法再读取。
6. 2026-10-04 已向共享环境定点更新 `shijingGuide` 代码（Nodejs16.13，`index.main`）；线上状态 `Active`，代码详情已核对管理员草稿/发布接口，普通用户 `publish/like` 仍返回 `FEATURE_CLOSED`，`list/get` 只公开 `official === true && status === 'approved'` 的编辑内容。当前线上 `shijingGuide`、`shijingAdmin`、`shijingInitData` 尚未配置 `ADMIN_OPENIDS`，管理操作会被安全拒绝，必须按第 4 步配置后再验收。`shijing_guides`、`shijing_guide_likes` 的线上权限均已核验为 `ADMINONLY`；已有 `status + official + createdAt` 复合索引。历史文档未删除，小程序客户端尚未上传。上传前仍需在微信开发者工具和真机上确认旧客户端投稿被拒绝、普通用户无法调用管理员接口、草稿及下架内容不可见，并核对景区信息服务是否有个人主体可用的匹配类目。
7. 客户端攻略列表/详情以云端公开结果为准；云端空列表、下架或读取失败时不再回退到内置资料，避免已撤下内容重新展示。内置资料仅供主动关闭云开发后的本地演示及管理员首次初始化；已移除未注册的投稿页面与虚构互动数。历史云文档与旧客户端本人删除接口未动。管理员整理内容不等于自动通过微信平台审核，类目和页面仍须以实际审核结果为准。

### 攻略搜索与标签

- 攻略页支持按标题、摘要、正文段落和关联景区名搜索；输入停止 300ms 后才调用云函数，回车确认的关键词写入独立的 `sj_guide_search_history`，不会混入景区搜索历史。
- 搜索采用标题、景区名、标签、摘要、正文依次降权的相关性排序，并兼容“抢票/放票/预约、避坑/避雷、路线/行程、美食/小吃”等轻量同义词。关键词与标签可组合，筛选后再由服务端分页。
- 标签只能由管理员录入，支持逗号、中文逗号、顿号、分号或换行分隔；保存时自动去空、忽略大小写去重。每篇最多 10 个标签，每个最多 16 个字，客户端和 `shijingGuide` 云函数都会校验。
- 标签候选由 `shijingGuide` 的 `tags` 动作从 `official === true && status === 'approved'` 的内容聚合。公开 `list/get/tags` 均不暴露 `_openid`，历史用户投稿、草稿和下架稿不会进入搜索结果。
- 旧客户端不传 `keyword`、`tag` 或 `tags` 时继续使用原列表排序、分页和保存语义；旧管理端编辑已有攻略时不会把新版标签误清空。云端不可用显示重试错误态，正常返回零条则显示“没有找到相关攻略”，不会回退内置资料。
- 本轮修改了 `shijingGuide` 云函数，体验版验收前必须重新上传部署；无需新集合、模板、隐私权限或额外数据库索引，现有 `status + official + createdAt` 复合索引继续使用。

### 云同步 v2 部署顺序

收藏、浏览历史、旅行地图与行程使用 `schema=2 + baseRevision + 删除墓碑/清空水位` 同步协议。`shijingUserData` 云函数会在事务中校验 revision；发现其他设备已更新时返回 `SYNC_CONFLICT`，客户端合并后只重试一次。云端读取失败时，客户端不会上传本机空快照。浏览历史与旅行地图均以向后兼容字段加入 v2，未提交字段的旧客户端不会覆盖对应云端数据。

- 上传失败按约 2 秒、10 秒、60 秒退避重试；网络恢复会立即续接，App 回到前台时距最近成功同步超过 1 分钟才重新拉取。所有入口仍要求已有云端 profile，不新增登录弹窗或主动登录。
- 收藏、行程各保留最新/最近更新的 500 条，浏览历史保留最近 200 条；旅行地图省份状态各最多 34 项、景区状态各最多 500 项。上传前按类别独立裁剪，单一类别超限不会阻断其他类别；删除墓碑按时间去重并优先保留最近 500 条。
- `push` 与 `pull` 均采用单飞；拉取失败会撤销 `baselineReady`，在重新取得云端基线前继续禁止上传。
- 确认真实 openid 从 A 切换到 B 时，客户端会先纯本地隔离清空 A 的收藏、足迹、行程、墓碑与同步状态，再拉取 B 的基线；请求失败时也不会显示或上传 A 的数据。匿名本地身份首次升级为真实 openid 时则保留离线数据，待基线成功后合并上传。
- 新云函数响应包含可选 `serverTime`，客户端按请求往返中点计算并持久化时钟偏移，后续同步时间戳使用校正时间；旧云函数、首次离线或偏移缺失时继续安全使用本机时间。条目与墓碑时间相差不超过 15 分钟时，客户端与云函数均优先采信删除，降低快时钟设备复活已删除数据的风险。
- 新云函数与旧客户端同账号混用时，服务端仍会执行删除优先规则，旧客户端可能在下次拉取前短暂显示旧合并结果；新客户端连接旧云函数时可使用本地校正规则，但服务端尚不能兜底。因此必须先部署云函数，再上传新版客户端。

1. 先备份 `shijing_user_data` 集合，再部署新版 `shijingUserData` 云函数。
2. 上传体验版；用同一 openid 的两台设备测试新增、编辑、删除、断网恢复和并发修改。
3. 确认云函数日志中的 revision 连续递增、删除墓碑存在，并确认新设备首次拉取后数据一致。
4. 再发布客户端。某用户的文档升级到 schema 2 后，旧客户端继续上传会收到 `CLIENT_UPGRADE_REQUIRED`，不会覆盖新版快照。

> 本地 `npm run check` 只能验证源码与渠道数据格式，不能证明云函数已部署、云数据库已有正确快照或真机同步已经通过。

### 行程订阅消息提醒

订阅提醒是完全可选的旁路能力，不写入 `shijing_user_data` 同步协议。用户点击“保存行程”后才会请求一次性订阅授权；模板 ID 为空、用户拒绝、断网或云函数异常时只记录日志，本地保存、页面关闭和 v2 同步均继续执行。

1. 在微信公众平台当前小程序的「功能 → 订阅消息」中，从当前服务类目可用的公共模板库选择或申请两个标题不同的一次性模板：
   - 建议标题「出行提醒」或「行程开始提醒」：景区名称、出行日期、出行时段、温馨提示。
   - 建议标题「预约提醒」或「预约开始提醒」：景区名称、建议预约日、出行日期、温馨提示。
2. 将模板 ID 填入 `miniprogram/constants/config.ts` 的 `SUBSCRIBE_TEMPLATE_IDS`；保持空字符串时客户端会静默跳过。
3. 在 `shijingReminder` 云函数环境变量配置同一组 ID：`TRIP_REMINDER_TEMPLATE_ID`、`RELEASE_REMINDER_TEMPLATE_ID`。默认字段编号分别按 `thing1/date2/thing3/thing4` 与 `thing1/date2/date3/thing4` 发送；如果后台实际关键词编号不同，用以下环境变量覆盖，无需改代码：
   - 出行模板：`TRIP_REMINDER_SCENIC_KEY`、`TRIP_REMINDER_DATE_KEY`、`TRIP_REMINDER_PERIOD_KEY`、`TRIP_REMINDER_NOTE_KEY`。
   - 预约模板：`RELEASE_REMINDER_SCENIC_KEY`、`RELEASE_REMINDER_DATE_KEY`、`RELEASE_REMINDER_VISIT_DATE_KEY`、`RELEASE_REMINDER_NOTE_KEY`。
   - 消息点击后打开的版本由 `REMINDER_MINIPROGRAM_STATE` 控制，可填 `developer`、`trial` 或 `formal`；未配置时默认 `formal`，体验版验收阶段建议明确设为 `trial`。
4. 上传 `shijingReminder` 时同时上传触发器。`config.json` 使用七段 Cron `0 0 9 * * * *`，目标为每天 Asia/Shanghai 09:00；同时给云函数环境变量设置 `TZ=Asia/Shanghai`。部署后必须在云开发控制台确认触发器时区、下一次执行时间和启用状态。云函数内部的自然日计算仍固定按 UTC+8，避免 Node 运行时 UTC 导致跨日。
5. 将 `shijing_reminders`、`shijing_reminder_logs` 设置为客户端不可读写，并建立上面的日期索引。函数会尝试创建缺失集合，但不会代替权限和索引配置。
6. 先部署云函数、配置模板环境变量并验证定时器，再上传体验版客户端。订阅消息涉及用户行程日期与服务通知，应在隐私说明中如实说明用途、保存范围和取消方式。

服务端会重新计算出行前一天及 `visitDate - advanceDays`，不接收客户端计算结论；没有 `advanceDays` 的行程不会产生预约提醒。发送前还会核对云端行程是否仍存在、是否已出行、日期是否一致，并以 `openid + tripId + reminderType` 的发送日志在发送前占位，同类提醒最多发送一次。当前项目使用共享云环境，登记时会从微信上下文保存 `FROM_APPID`，定时发送时通过 `cloud.openapi({ appid })` 明确以来源小程序身份发送；部署后仍须用当前 AppID 的真实模板和真机 OpenID 完成一次发送验收。

### 行程只读分享

- 行程页先续接现有云同步，再调用 `shijingTripShare` 由服务端读取当前 openid 对应的 `shijing_user_data.trips`，生成独立快照；该流程不修改同步协议 v2 的 revision、墓碑或清空水位。
- 默认快照只包含景区名、日期、时段和状态。备注与出行清单分别由分享者显式勾选后才会写入；客户端不上传 openid，也不上传完整行程对象。
- `shareId` 为 192 位加密随机值，链接默认 30 天有效。公开 `get` 只返回白名单字段，不返回分享者 openid；只累计匿名查看次数和最近查看时间，不保存查看者身份。
- 分享者可以撤销当前快照；删除原行程不会自动删除已生成快照。集合 `shijing_trip_shares` 必须设置为客户端不可读写，仅允许 `shijingTripShare` 云函数访问。
- 发布前先部署 `shijingTripShare` 并创建或确认 `shijing_trip_shares` 集合。隐私说明应补充：用户主动生成行程分享链接后，所选行程字段会形成 30 天内可访问的只读快照，并可由获得链接的人查看；未勾选时不包含备注和清单。当前版本在 30 天后由接口拒绝访问，但不会自动物理删除过期文档，因此还应据实说明后续清理周期，或另行配置定时清理后再声明最长保留期。

### 朋友圈分享与景区分享图

- 首页、景区详情、攻略列表、攻略详情和有效的行程只读快照已启用 `onShareTimeline`。详情页通过 `query=id=...` 恢复相同内容；首页与攻略列表会保留省份、分类和范围筛选。朋友圈不支持自定义 `path`，因此代码只返回 `title`、`query` 和可选图片。
- “我的行程”“我的收藏”“浏览历史”属于私人原始数据页，仍不直接开放朋友圈；行程只能先生成最小化只读快照，再从 `trip-share` 页面分享。
- 景区分享图使用本机 Canvas 2D 绘制，复用 `TONES` 传统色渐变，包含景区名、城市、等级、旺季门票、热度、口碑、拾景品牌和“不参与售票”说明。画布按 `wx.getWindowInfo()` 返回的 DPR 设置实际像素，长文本按测量宽度裁剪。
- 生成成功后，好友分享和朋友圈分享会附带本地临时 `imageUrl`；生成失败时自动回退普通页面分享，不影响跳转。保存相册只在用户主动点击后调用 `wx.saveImageToPhotosAlbum`，拒绝权限时只提示，不会在启动阶段申请。
- 当前版本未叠加小程序码：无需新增云函数或依赖，避免云函数不可用时阻断分享。后续如增加，必须保持“取码失败仍导出无小程序码海报”的降级路径。

### 景区位置与一键导航

- `Scenic.location` 为可选的 `{ lat, lng }`，`address` 也为可选字段。内置示例数据不预填任何坐标；只有管理员从可追溯来源核验后才能录入，坐标统一使用 GCJ-02。
- 景区详情仅在坐标合法时显示独立的“所在位置”卡片，点击后调用 `wx.openLocation`。该操作只打开目的地地图，不读取用户当前位置，也不会主动调用 `wx.authorize`。
- 首页“离我最近”只在用户主动点击时调用一次 `wx.getLocation({ type: 'gcj02' })`，用户坐标只在当前页面内存中用于 Haversine 直线距离排序，不写入 storage 或云端。部分景区没有坐标时按热度排在后面；当前筛选范围完全没有坐标时整个榜单回退为热度排序。
- `app.json` 已声明 `requiredPrivateInfos: ['getLocation']` 和具体用途的 `scope.userLocation.desc`。发布前还需在微信公众平台当前 AppID 的「开发管理 → 接口设置」检查并申请 `wx.getLocation`，并在《用户隐私保护指引》中如实声明“用于按直线距离展示附近景区”。只使用 `wx.getLocation`、`wx.openLocation` 和本地距离计算，不需要腾讯位置服务 Key。
- 管理页经纬度必须同时填写或同时清空：纬度闭区间 `[-90, 90]`、经度闭区间 `[-180, 180]`。客户端和 `shijingAdmin` 云函数都会校验；旧客户端未提交位置字段时，云端原坐标保持不变。
- 本轮修改了 `shijingAdmin` 的可选字段保存逻辑，必须先重新上传部署该云函数，再用管理端维护真实坐标。`shijingUserData` 和同步协议 v2 未改动。

### 出行天气（默认关闭）

- 天气是行程卡片的可选异步信息。行程与编辑弹层会先正常渲染，随后才读取天气；未配置、地点缺失、超时、接口失败或返回无法识别时，天气区域会完全隐藏，不弹 Toast，也不会影响行程保存和云同步 v2。
- 当前默认关闭：`miniprogram/constants/config.ts` 中 `WEATHER_API_CONFIG.endpoint` 与 `WEATHER_API_CONFIG.key` 均为空。只有两项都填写时才会调用 `wx.request`；请勿把真实生产密钥提交到公开仓库，生产环境建议通过受控网关转发并限制调用来源与配额。
- 默认请求方式为 HTTPS GET，参数为 `key`、`location`、`date`。`location` 优先传景区已核验地址，没有地址时传 `lng,lat`；`date` 为 `YYYY-MM-DD`。服务兼容通用 `{ weather: { text, temperature/high/low } }`，并兼容常见 QWeather、WeatherAPI 与高德逐日响应字段。若供应商参数或签名不同，请使用自有网关转换为这一约定，不要在页面层拼装请求。
- 必须在微信公众平台把 endpoint 的 HTTPS 域名加入【开发管理 → 开发设置 → 服务器域名 → request 合法域名】；域名需完成平台要求的备案与 HTTPS 证书配置。开发者工具勾选“不校验合法域名”只适合本地调试，不能替代真机和正式版白名单。
- 同一“本地自然日 + 出行日 + 目的地”只请求一次，结果写入 `STORAGE_KEYS.weatherCache`。景区地址/坐标也只作为本地派生缓存保存，不写入行程对象、不上传云端；因此旧行程或换设备后若没有可核验地点，会静默跳过天气，不会为了天气额外请求景区列表或详情。

### 收藏、行程备份与系统日历文本

- 收藏页可把全部收藏生成纯文本备份；行程页可生成完整行程备份，日期待定的行程也会保留。文本只读取当前本地快照，不修改 `shijing_user_data`、revision、墓碑或清空水位。
- 行程页还可把已填写日期的行程整理成日程文本。小程序无法直接写入系统日历，因此这里只调用 `wx.setClipboardData`：复制后由用户打开系统日历、新建日程并粘贴，不申请日历权限，也不在后台静默创建事件。
- 导出预览使用可长按选择的 `<text>`。剪贴板调用失败时弹层不会关闭，用户仍可长按手动选择复制；没有收藏、没有行程或没有已填写日期的行程时不会生成空文本，只显示明确提示。
- 纯文本格式集中在 `miniprogram/utils/export-text.ts`，保持为无 storage、无云函数、无微信 API 副作用的纯函数，便于回归测试和后续调整格式。

## 维护景区购票入口

建议在小程序「关于 → 资料维护中心」逐条维护，而不是直接覆盖云数据库整篇文档。渠道标为「已核验」前，必须填写真实来源和核验日期；小程序跳转的实际 AppID、路径和目标主体仍需真机逐条验证。集合 `shijing_scenics` 应保持客户端只读、云函数写入；云函数异常可在云开发控制台日志中排查。景区列表按名称分页读取，数据量增长后应为 `name` 增加索引。

`ticket` 字段决定跳转方式（见 `miniprogram/types/index.ts`）：

```js
{ type: 'miniprogram', name: '云冈石窟文旅', shortLink: '#小程序://云冈石窟文旅/DtrLibxWRIZOPGh', verified: true }
{ type: 'miniprogram', name: 'xxx', appId: 'wx...', path: 'pages/index/index' }
{ type: 'web', name: '官网', url: 'https://...' }   // 小程序无法打开外链，采用复制链接
{ type: 'free', name: '免费开放，需预约' }
```

- 小程序短链获取：在目标小程序右上角「···」→「复制链接」。
- 仅填写 `name` 而无可直达信息时，按钮显示「查看渠道信息」，点击复制名称引导用户自行核对。
- 完成官方主体及跳转目标核验后设置 `verified: true`，并记录来源与核验日期；详情页才显示「已核验」。
- 若填写了 `validUntil`，到期当天仍有效，次日起前台显示「核验已过期」；待核验或已过期入口不再直接跳转、拨号或复制原链接，只复制渠道名称供用户重新核对。未填 `validUntil` 不会被系统擅自判定为过期。行程里的旧渠道快照也不再直接用于跳转，而是打开景区详情查看当前资料。
- 游客量等为参考数据，请在 `shijing_scenics` 集合中持续校准。

### 多官方渠道、资料来源与预约规则

景区可在保留旧 `ticket` / `booking` 字段的同时，逐步迁移到新的结构化字段。未核验的值应留空，不要根据攻略或第三方网页猜测。

```js
{
  // 同一景区可区分门票、索道、演出、交通和讲解等官方入口。
  officialEntries: [
    {
      id: 'ticket-main',
      purpose: 'ticket',
      type: 'miniprogram',
      name: '景区官方小程序',
      shortLink: '#小程序://.../...',
      verified: true,
      sourceName: '景区官方公告',
      sourceUrl: 'https://...',
      checkedAt: '2026-10-01'
    }
  ],
  reservation: {
    required: true,
    advanceDays: 7,
    releaseTime: '每日 20:00 开放第 7 日预约',
    realName: true,
    documents: ['居民身份证'],
    timeSlotRequired: true,
    refundRule: '以景区官方订单页为准'
  },
  sources: [
    {
      id: 'official-notice',
      name: '景区官方公告',
      url: 'https://...',
      checkedAt: '2026-10-01',
      validUntil: '2026-12-31'
    }
  ]
}
```

- `officialEntries[].id` 需在单个景区内唯一；`purpose` 支持 `ticket / reservation / cableway / performance / transport / guide / other`。
- 页面优先显示 `officialEntries`；没有新字段时自动兼容旧 `ticket`。
- 结构化 `reservation` 有值时按字段展示，否则继续显示旧 `booking` 文案。
- `sources` 为景区资料追溯记录；渠道自身的核验证据可记录在 `officialEntries[].sourceName / sourceUrl / checkedAt`。

### 临时公告与搜索词

```js
{
  searchKeywords: ['yungang', 'yungangshiku', '云岗石窟'],
  tags: ['古建', '世界遗产'],
  notices: [
    {
      id: 'official-notice-20261001',
      type: 'closure', // closure / weather / limit / maintenance / info
      title: '临时闭园公告',
      content: '只填写已由景区官方发布并人工核对的内容。',
      startAt: '2026-10-01',
      endAt: '2026-10-02',
      sourceName: '景区官方公告',
      sourceUrl: 'https://...',
      checkedAt: '2026-10-01'
    }
  ]
}
```

- 公告只在 `startAt <= 当天 <= endAt` 时显示；缺少起止日期时视为当前有效。
- 临时闭园、天气影响等公告必须保留官方来源和核验日期，禁止根据第三方攻略自动生成。

## 分包结构与路由兼容

- 主包保留 `home / favorites / trips / mine` 四个 tabBar 页面，以及高频的 `scenic / guides`。景区详情和攻略列表会从首页、收藏及分享入口频繁打开，留在主包可避免核心浏览链路首次进入时额外下载分包。
- `packageAdmin` 包含 `admin / admin-editor / admin-guides / admin-guide-editor`，仅管理员维护资料时加载。
- `packageExtra` 包含 `compare / correction / trip-share / about / profile / search / guide-detail / footprints / travel-map`，这些页面不是首屏必需能力；真实省界几何也只随该分包加载。
- 分包页面完整路径必须使用 `/<root>/<page>`，例如攻略详情为 `/packageExtra/pages/guide-detail/index?id=...`，行程分享为 `/packageExtra/pages/trip-share/index?id=...`。好友分享的 `path` 已同步迁移；朋友圈分享仍按微信规则使用当前页面加 `query`。`sitemap.json` 继续以 `page: "*"` 覆盖主包和分包页面。
- `tools/check-subpackages.js` 会检查分包声明、物理页面文件、tabBar 主包归属、源码路由、好友分享深链和 sitemap；新增页面或调整 root 后必须同步通过该检查。

### 分包前后体积实测

测量口径为工作区 `miniprogram/` 下实际文件的未压缩字节数；分包后主包数值为总字节数减去两个分包目录。它适合比较本次拆分效果，但不等同于微信开发者工具编译、压缩和“忽略未使用文件”后的最终上传包，请在上传体验版前再以开发者工具【代码质量 / 包体积】结果复核。

| 项目 | 实测体积 |
| --- | ---: |
| `miniprogram/data/scenics.ts` | 37,370 B |
| `miniprogram/data/guides.ts` | 8,852 B |
| 两份内置数据合计 | 46,222 B |
| 分包前主包（改动前实测） | 1,876,861 B（约 1.790 MiB） |
| 分包后主包（含旅行地图首页质心点阵逻辑） | 1,798,168 B（约 1.715 MiB） |
| `packageAdmin` | 50,214 B |
| `packageExtra`（含 408,828 B 省界资产） | 478,940 B（约 0.457 MiB） |
| 分包后全部代码总计 | 2,327,322 B（约 2.219 MiB） |

按 2 MiB（2,097,152 B）主包上限比较：当前主包约占 85.7%，剩余约 292 KiB。旅行地图的 408,828 B 真实省界资产只进入 `packageExtra`，不会计入主包；当前没有触碰、删除或移动 `miniprogram/data/scenics.ts` 与 `guides.ts`。这里是工作区未压缩体积，最终仍以微信开发者工具的上传包分析为准。

## 景区与攻略数据云化方案（本轮仅评估）

本轮不执行云化迁移，也不修改云函数。目标形态是“内置数据保留用于本地演示和管理员首次初始化；云端集合保存线上权威数据；本地保存最近一次成功云快照作为离线兜底”。

1. **权威集合与字段**
   - 继续使用现有 `shijing_scenics`、`shijing_guides`，保持稳定 `_id`。景区保留 `contentRevision / updatedAt`；攻略保留 `official / status / contentRevision / updatedAt`，公开接口继续只读 `official === true && status === 'approved'`。
   - 后续以可选字段渐进增加 `schemaVersion`、`datasetVersion`、`serverUpdatedAt`；下架或删除使用状态/墓碑，不立即物理删除，避免离线数据复活。
   - 新增内容元数据集合 `shijing_content_meta`，以 `scenics`、`guides` 为文档 ID，记录 `activeVersion`、`schemaVersion`、`publishedAt`、`checksum`、`minClientVersion`、`previousVersion`。常用索引继续覆盖景区省份与排序字段、攻略公开状态与发布时间。
2. **首次初始化与发布**
   - 内置 `SCENICS / GUIDES` 作为有版本号的 seed；管理员通过现有初始化流程分批写入，仅补缺失 `_id`，绝不覆盖云端已维护文档。
   - 写入 staging 版本后校验条数、必填字段、重复 ID、攻略公开状态和 checksum；校验通过才原子切换元数据中的 `activeVersion`。初始化失败时不切换版本。
   - 客户端成功取得元数据与分页内容后，保存“最近一次成功”的轻量云快照和版本。之后云端是权威来源，管理员修改只写云端并递增 revision。
3. **离线兜底边界**
   - 已成功同步过的设备离线时读取最近一次成功云快照，不直接退回原始 seed，避免已下架攻略重新出现。
   - 从未取得过云基线的设备，才允许使用内置数据完成本地演示或首次 bootstrap；一旦取得云端版本，就以云端状态和下架墓碑覆盖 seed。
   - 缓存读取失败只影响内容列表，不得触发登录、不得写用户同步数据，也不得改动收藏/浏览历史/行程的同步协议 v2。
4. **灰度与回滚**
   - 依次采用 `local → shadow → cloud`：先保持本地渲染并后台只读比对云端条数/checksum，再给体验版和少量版本启用云端权威读取，确认空列表率、错误率和延迟后全量。
   - 每次发布保留上一 `activeVersion` 及数据库导出；异常时只回切元数据版本，不覆盖管理员新数据。新字段全部保持可选，旧客户端仍能读取旧字段。
   - 回滚期间客户端优先使用上一份已验证云快照；内置文件始终留在安装包中作为最终演示/初始化资源。景区、攻略云化与用户数据同步使用不同集合和协议，不能复用或推进 `shijing_user_data` 的 revision。

## 目录结构

```
miniprogram/
├── app.ts / app.json / app.less   入口、路由、设计令牌（传统色）
├── custom-tab-bar/                悬浮胶囊 TabBar（行程角标 = 待抢票数）
├── components/
│   ├── page-header/               自定义导航头（沉浸 / 毛玻璃）
│   ├── tone-cover/                无图封面：传统色渐变 + 远山剪影
│   ├── scenic-card/               景区卡（榜首 / 榜单 / 紧凑）
│   ├── guide-card/                攻略卡
│   ├── province-picker/           省份选择（按大区）
│   ├── trip-sheet/                加入 / 编辑行程
│   └── empty-state/
├── pages/
│   ├── home/        发现：省份切换 + 排序榜单 + 收藏库入口
│   ├── favorites/   私人收藏库：搜索、筛选、排序、增量展示
│   ├── scenic/      景区详情：指标、放票规则、要点、避雷、官方购票
│   ├── guides/      攻略列表（分类 / 全国·本省）
│   ├── trips/       我的行程
│   └── mine/        个人资料、收藏/浏览历史/行程统计入口
├── packageAdmin/pages/
│   └── admin/ admin-editor/ admin-guides/ admin-guide-editor/
├── packageExtra/pages/
│   └── compare/ correction/ trip-share/ about/ profile/ search/ guide-detail/ footprints/
├── services/        cloud / scenic / guide / auth / ticket / reminder / trip-share
├── stores/          user-data（本地优先 + 云端同步）
├── constants/ data/ types/ utils/
cloudfunctions/      shijingLogin / shijingUserData / shijingReminder / shijingTripShare / shijingGuide / shijingInitData / shijingCorrection / shijingAdmin / shijingLog
```

## 类型检查

```bash
npm run check
```

其中 `check:tickets` 检查内置短链的格式与重复，`check:ticket-policy` 验证待核验、过期、缺路径入口不会直跳，`check:trip-share` 验证随机分享标识、字段最小化、失效空态与撤销权限；官方身份与实际跳转仍需逐条人工核验并在微信真机测试。

### 埋点与错误监控

客户端埋点统一由 `miniprogram/constants/analytics.ts` 上报：优先调用
`wx.reportEvent`，基础库不支持时回退到 `wx.reportAnalytics`；两个接口均不可用、
接口抛错或返回失败 Promise 时全部静默忽略，不影响页面操作。

需要在小程序后台「统计 → 自定义分析」配置以下事件及参数。所有参数均为低基数枚举、
条数、布尔值或耗时区间，未列入白名单的字段会在客户端被丢弃。

| 事件名 | 触发场景 | 允许参数 |
| --- | --- | --- |
| `home_load` | 首页景区数据加载完成或失败 | `page`、`action`、`scene`、`result`、`item_count`、`duration_bucket` |
| `scenic_open` | 打开景区详情 | `page`、`action`、`scene`、`result`、`duration_bucket` |
| `ticket_click` | 点击、复制或查看官方购票入口 | `page`、`action`、`scene`、`result` |
| `favorite_toggle` | 收藏或取消收藏景区/攻略 | `page`、`action`、`scene`、`result` |
| `trip_save` | 新增或编辑行程成功 | `page`、`action`、`scene`、`result`、`item_count` |
| `data_export` | 复制收藏或行程备份文本 | `page`、`action`、`scene`、`result`、`item_count` |
| `calendar_copy` | 复制系统日历用日程文本 | `page`、`action`、`scene`、`result`、`item_count` |
| `guide_search` | 攻略关键词/标签查询完成 | `page`、`action`、`scene`、`result`、`item_count`、`query_length`、`hit`、`tag_selected`、`duration_bucket` |
| `share_click` | 页面分享给好友或朋友圈 | `page`、`action`、`scene`、`result` |
| `guide_open` | 打开官方攻略详情 | `page`、`action`、`scene`、`result`、`duration_bucket` |
| `client_error` | 捕获全局错误或未处理 Promise | `page`、`action`、`scene`、`result` |

隐私合规约束：埋点绝不上报 `openid`、昵称、头像、用户备注、行程清单内容、
搜索关键词原文、分享标识或景区/攻略 ID；攻略搜索只上报关键词长度、是否命中和是否选择标签。
全局异常会先在客户端脱敏，再由 `shijingLog` 云函数二次脱敏并写入 `shijing_logs`；
日志正文最多 800 字，同一调用方每分钟最多 5 条、单函数实例每分钟最多 30 条、
集合全局每分钟最多 200 条。日志集合不得开放客户端直接读写权限，也不保存 `openid`。

首次启用错误监控时，需要在云开发中上传并部署 `cloudfunctions/shijingLog`（云端安装依赖），
确认 `shijing_logs` 集合仅云函数可写；建议为 `minuteKey` 建普通索引，以降低全局限频计数开销。

## 发布前检查

- 【小程序后台 → 设置 → 服务内容声明 → 用户隐私保护指引】按实际调用声明：头像、昵称（仅个人资料展示）、剪贴板（复制购票链接）；私人行程备注和景区资料纠错的处理方式也需如实说明。
- 当前版本不开放用户投稿；仍须在小程序后台确认景区信息服务有个人主体可用的匹配类目，不能只靠改文案保证审核通过。
- 跳转其他小程序在真机上测试；开发者工具中仅为模拟。
