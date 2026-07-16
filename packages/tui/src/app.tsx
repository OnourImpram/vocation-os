import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import {
  createQueueViewModel,
  dispatchQueueAction,
  reduceTuiKeyboardState,
  renderQueueTextFallback,
  toDaemonQueueQuery,
  type QueueActionViewModel,
  type QueueEvidence,
  type QueueItem,
  type TuiAppProps,
  type TuiKeyboardEvent,
  type TuiKeyboardState
} from "./index.js";

export interface VocationTuiAppProps extends TuiAppProps {
  textOnly?: boolean;
}

function evidenceColor(status: QueueEvidence["status"]): "green" | "yellow" | "red" | "gray" {
  if (status === "verified") return "green";
  if (status === "operator-supplied") return "yellow";
  if (status === "stale") return "red";
  return "gray";
}

function Panel(props: Readonly<{ title: string; width?: number; flexGrow?: number; children: React.ReactNode }>) {
  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      flexDirection="column"
      paddingX={1}
      width={props.width}
      flexGrow={props.flexGrow}
      minHeight={8}
    >
      <Text bold color="cyan">{props.title}</Text>
      {props.children}
    </Box>
  );
}

function QueuePanel(props: Readonly<{
  rows: ReturnType<typeof createQueueViewModel>["rows"];
  width: number;
}>) {
  return (
    <Panel title="Queue" width={props.width}>
      {props.rows.length === 0 ? <Text dimColor>No matching queue items.</Text> : props.rows.map((row) => (
        <Box key={row.id} gap={1}>
          <Text {...(row.selected ? { color: "cyan" as const } : {})}>{row.selected ? ">" : " "}</Text>
          <Box flexDirection="column" flexGrow={1}>
            <Text bold={row.selected} wrap="truncate-end">{row.primaryText}</Text>
            <Text dimColor wrap="truncate-end">{row.secondaryText}</Text>
          </Box>
          <Text color={row.statusTone === "danger" ? "red" : row.statusTone === "success" ? "green" : "yellow"}>
            {row.statusLabel}
          </Text>
        </Box>
      ))}
    </Panel>
  );
}

function DetailPanel(props: Readonly<{ item: QueueItem | null }>) {
  return (
    <Panel title="Detail" flexGrow={1}>
      {!props.item ? <Text dimColor>Select a queue item.</Text> : (
        <>
          <Text bold>{props.item.title}</Text>
          <Text color="cyan">{props.item.organization}</Text>
          <Text>{props.item.summary ?? `Opportunity ${props.item.opportunityId}`}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text><Text dimColor>Status </Text>{props.item.status}</Text>
            <Text><Text dimColor>Updated </Text>{props.item.updatedAt}</Text>
            <Text><Text dimColor>Version </Text>{props.item.version}</Text>
            {props.item.blocker ? <Text color="red"><Text dimColor>Blocker </Text>{props.item.blocker}</Text> : null}
          </Box>
        </>
      )}
    </Panel>
  );
}

function EvidencePanel(props: Readonly<{ evidence: readonly QueueEvidence[] }>) {
  return (
    <Panel title="Evidence" flexGrow={1}>
      {props.evidence.length === 0 ? <Text dimColor>No evidence attached.</Text> : props.evidence.map((item) => (
        <Box key={item.id} flexDirection="column" marginBottom={1}>
          <Text color={evidenceColor(item.status)}>{item.status === "verified" ? "[x]" : "[ ]"} {item.label}</Text>
          <Text dimColor wrap="truncate-end">{item.source ?? item.status}</Text>
        </Box>
      ))}
    </Panel>
  );
}

function ActionsPanel(props: Readonly<{
  actions: readonly QueueActionViewModel[];
  selectedIndex: number;
}>) {
  return (
    <Panel title="Actions" flexGrow={1}>
      {props.actions.length === 0 ? <Text dimColor>No actions available.</Text> : props.actions.map((action, index) => (
        <Box key={action.id} gap={1}>
          <Text {...(index === props.selectedIndex ? { color: "cyan" as const } : {})}>
            {index === props.selectedIndex ? ">" : " "}
          </Text>
          <Text
            bold={index === props.selectedIndex}
            {...(action.tone === "danger"
              ? { color: "red" as const }
              : action.tone === "primary"
                ? { color: "cyan" as const }
                : {})}
          >
            {action.label}
          </Text>
          {action.requiresScopedApproval ? <Text color="yellow">approval</Text> : null}
        </Box>
      ))}
    </Panel>
  );
}

function keyboardEvent(input: string, key: Readonly<{
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  home: boolean;
  end: boolean;
}>): TuiKeyboardEvent | null {
  if (key.upArrow || input === "k") return "up";
  if (key.downArrow || input === "j") return "down";
  if (key.leftArrow || input === "h") return "left";
  if (key.rightArrow || input === "l") return "right";
  if (key.home) return "home";
  if (key.end) return "end";
  return null;
}

export function VocationTuiApp({ daemon, initialFilters, textOnly = false }: VocationTuiAppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [items, setItems] = useState<readonly QueueItem[]>([]);
  const [filters, setFilters] = useState(initialFilters);
  const [keyboard, setKeyboard] = useState<TuiKeyboardState>({ selectedIndex: 0, actionIndex: 0 });
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("Connecting to daemon");

  const refresh = useCallback(async () => {
    setLoading(true);
    setStatus("Refreshing queue");
    try {
      const nextItems = await daemon.queryQueue(toDaemonQueueQuery(filters));
      setItems(nextItems);
      setKeyboard((current) => ({
        selectedIndex: Math.min(current.selectedIndex, Math.max(0, nextItems.length - 1)),
        actionIndex: 0
      }));
      setStatus(`Queue current at ${new Date().toISOString()}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Daemon request failed");
    } finally {
      setLoading(false);
    }
  }, [daemon, filters]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const preliminary = useMemo(
    () => createQueueViewModel(items, filters, null),
    [filters, items]
  );
  const selectedId = preliminary.rows[keyboard.selectedIndex]?.id ?? null;
  const viewModel = useMemo(
    () => createQueueViewModel(items, filters, selectedId),
    [filters, items, selectedId]
  );
  const selectedRow = viewModel.rows.find((row) => row.id === viewModel.selectedId) ?? null;
  const selectedItem = items.find((item) => item.attemptId === viewModel.selectedId) ?? null;
  const actions = selectedRow?.actions ?? [];

  const activateAction = useCallback(async () => {
    const action = actions[keyboard.actionIndex];
    if (!action) return;
    if (!action.command) {
      setStatus("Detail is active");
      return;
    }
    setStatus(`Sending ${action.label} to daemon`);
    try {
      const result = await dispatchQueueAction(daemon, action);
      setStatus(`${result.accepted ? "Accepted" : "Rejected"}: ${result.message}`);
      if (result.accepted) await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Daemon command failed");
    }
  }, [actions, daemon, keyboard.actionIndex, refresh]);

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      exit();
      return;
    }
    if (input === "r") {
      void refresh();
      return;
    }
    if (key.tab) {
      setFilters((current) => {
        const kinds = current.queueKinds ?? ["applications"];
        const next = kinds.length === 2
          ? ["applications"] as const
          : kinds[0] === "applications"
            ? ["discovery"] as const
            : ["applications", "discovery"] as const;
        return { ...current, queueKinds: next };
      });
      setKeyboard({ selectedIndex: 0, actionIndex: 0 });
      return;
    }
    if (key.return) {
      void activateAction();
      return;
    }
    const event = keyboardEvent(input, key);
    if (event) {
      setKeyboard((current) => reduceTuiKeyboardState(current, event, viewModel.rows.length, actions.length));
    }
  });

  const columns = stdout.columns ?? 80;
  if (textOnly || columns < 80) {
    return (
      <Box flexDirection="column">
        <Text>{renderQueueTextFallback(viewModel, selectedItem, keyboard.actionIndex)}</Text>
        <Text color={loading ? "yellow" : "gray"}>{status}</Text>
      </Box>
    );
  }

  const wide = columns >= 112;
  return (
    <Box flexDirection="column" width="100%">
      <Box justifyContent="space-between" paddingX={1}>
        <Text bold color="cyan">VocationOS</Text>
        <Text>{(filters.queueKinds ?? ["applications"]).join(" + ")} | {viewModel.summary.visible}/{viewModel.summary.total}</Text>
      </Box>
      <Box flexDirection="row">
        <QueuePanel rows={viewModel.rows} width={Math.min(40, Math.max(30, Math.floor(columns * 0.3)))} />
        <Box flexDirection="column" flexGrow={1}>
          <DetailPanel item={selectedItem} />
          <Box flexDirection={wide ? "row" : "column"}>
            <EvidencePanel evidence={selectedItem?.evidence ?? []} />
            <ActionsPanel actions={actions} selectedIndex={keyboard.actionIndex} />
          </Box>
        </Box>
      </Box>
      <Box paddingX={1}>
        <Text color={loading ? "yellow" : "gray"}>{status}</Text>
      </Box>
    </Box>
  );
}
