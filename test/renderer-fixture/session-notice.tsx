function SessionNoticeMessageV2(props: { message: SessionMessageInfo }) {
  const ctx = use()
  const theme = useTheme()
  const renderer = useRenderer()
  const { navigate } = useRoute()
  const [hover, setHover] = createSignal(false)
  const metadata = () => (props.message.type === "synthetic" ? props.message.metadata : undefined)
  const source = () => stringValue(metadata()?.source)
  const completion = () => source() === "subagent" || source() === "shell"
  const childID = () => (source() === "subagent" ? stringValue(metadata()?.childID) : undefined)
  const state = () => stringValue(metadata()?.state)
  const actor = () => (source() === "shell" ? "Shell" : Locale.titlecase(stringValue(metadata()?.agent) ?? "Subagent"))
  const text = () => {
    if (props.message.type === "system") return props.message.description ?? "Instructions updated"
    if (props.message.type === "synthetic") return props.message.description ?? ""
    return ""
  }
  const description = () => (source() === "shell" ? text().replace(/\s+/g, " ").trim() : text())
  const status = () => {
    if (state() === "completed") return "finished"
    if (state() === "error") return "failed"
    return state() ?? "finished"
  }
  const heading = () => `${state() === "completed" ? "↳" : "!"} ${actor()} ${status()}`
  const suffix = () => Locale.truncateWidth(` · ${description()}`, Math.max(0, ctx.width - 3 - stringWidth(heading())))
  const color = () => {
    if (state() === "error") return theme.text.feedback.error.base
    if (state() === "cancelled") return theme.text.feedback.warning.base
    if (hover() && childID()) return theme.text.base
    return theme.text.feedback.info.base
  }
  return (
    <Show
      when={completion()}
      fallback={
        <InlineToolRow icon={source() === "goal" ? "◎" : "◈"} color={theme.text.muted} pending="Notice" complete={true}>
          {text()}
        </InlineToolRow>
      }
    >
      <box
        marginLeft={3}
        onMouseOver={() => childID() && setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={() => {
          if (renderer.getSelection()?.getSelectedText()) return
          const id = childID()
          if (id) navigate({ type: "session", sessionID: id })
        }}
      >
        <text wrapMode="none">
          <span style={{ fg: color() }}>{heading()}</span>
          <span style={{ fg: theme.text.muted }}>{suffix()}</span>
        </text>
      </box>
    </Show>
  )
}
