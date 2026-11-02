export function InlineToolRow(props: {
  icon: string
  iconColor?: RGBA
  color?: RGBA
  errorColor?: RGBA
  failed?: boolean
  denied?: boolean
  error?: string
  errorExpanded?: boolean
  complete: unknown
  pending: string
  failure?: string
  spinner?: boolean
  status?: JSX.Element
  children: JSX.Element
  onMouseOver?: () => void
  onMouseOut?: () => void
  onMouseUp?: (event: MouseEvent) => void
}) {
  return (
    <box paddingLeft={3} onMouseOver={props.onMouseOver} onMouseOut={props.onMouseOut} onMouseUp={props.onMouseUp}>
      <Switch>
        <Match when={props.spinner}>
          <Show when={props.status} fallback={<Spinner color={props.color} children={props.children} />}>
            {(status) => (
              <box flexDirection="row" gap={1}>
                <Spinner color={props.color} />
                <InlineToolLabel color={props.color} status={status()}>
                  {props.children}
                </InlineToolLabel>
              </box>
            )}
          </Show>
        </Match>
        <Match when={true}>
          <Show fallback={<Spinner color={props.color}>{props.pending}</Spinner>} when={props.complete || props.failed}>
            <box flexDirection="row">
              <text
                width={INLINE_TOOL_ICON_WIDTH}
                fg={props.failed ? props.errorColor : (props.iconColor ?? props.color)}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                {props.icon}
              </text>
              <Show
                when={props.status}
                fallback={
                  <text
                    flexGrow={1}
                    fg={props.failed ? props.errorColor : props.color}
                    attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
                  >
                    {props.failed && !props.complete ? (props.failure ?? props.children) : props.children}
                  </text>
                }
              >
                {(status) => (
                  <InlineToolLabel
                    color={props.failed ? props.errorColor : props.color}
                    denied={props.denied}
                    status={status()}
                  >
                    {props.failed && !props.complete ? (props.failure ?? props.children) : props.children}
                  </InlineToolLabel>
                )}
              </Show>
            </box>
          </Show>
        </Match>
      </Switch>
      <Show when={props.failed && props.errorExpanded}>
        <box paddingLeft={INLINE_TOOL_ICON_WIDTH}>
          <text fg={props.errorColor}>{props.error}</text>
        </box>
      </Show>
    </box>
  )
}
