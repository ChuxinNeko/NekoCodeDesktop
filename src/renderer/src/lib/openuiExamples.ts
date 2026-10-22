/** Executable examples shared by the model prompt and runtime contract tests. */
export const OPENUI_COUNTER_EXAMPLE = `root = Stack([header, counter, buttons])
header = CardHeader("本地计数器", "点击按钮直接更新，不调用 AI")
$count = 0
counter = TextContent("当前计数：" + $count, "large-heavy")
buttons = Buttons([increment, reset])
increment = Button("加一", @Set($count, $count + 1))
reset = Button("归零", @Reset($count), "secondary")`;

export const OPENUI_TRACKER_EXAMPLE = `root = Stack([header, form, search, summary, table])
header = CardHeader("任务管理", "任务保存在此应用的本地数据中")
$title = ""
$search = ""
$deleteId = ""
tasks = Query("app_list", {collection: "tasks"}, {rows: [], total: 0})
createTask = Mutation("app_save", {collection: "tasks", record: {title: $title, done: false}})
deleteTask = Mutation("app_delete", {collection: "tasks", id: $deleteId})
form = Form("create-task", Buttons([submit]), [titleField])
titleField = FormControl("任务名称", Input("title", "输入任务", "text", {required: true}, $title))
submit = Button("添加任务", Action([@Run(createTask), @Run(tasks), @Reset($title)]))
search = FormControl("筛选", Input("search", "按名称搜索", "text", null, $search))
filtered = @Filter(tasks.rows, "title", "contains", $search)
summary = TextContent("共 " + @Count(filtered) + " 个任务")
table = Table([Col("任务", filtered.title), Col("操作", @Each(filtered, "task", Button("删除", Action([@Set($deleteId, task.id), @Run(deleteTask), @Run(tasks)]))), "action")])`;
