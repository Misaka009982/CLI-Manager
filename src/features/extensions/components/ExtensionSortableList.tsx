import { useEffect, useState, type ReactNode } from "react";
import { ActionIcon } from "@mantine/core";
import { DndContext, PointerSensor, KeyboardSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { Store } from "@tauri-apps/plugin-store";
import { toast } from "sonner";
import { getCliManagerDataPaths } from "../../../shared/platform/appPaths";
import { useI18n } from "../../../shared/i18n";

let orderStore: Promise<Store> | undefined;
const getOrderStore = () => orderStore ??= getCliManagerDataPaths()
  .then(paths => Store.load(`${paths.dataDir}/extension-list-order.json`, { autoSave: false, defaults: {} }))
  .catch(error => { orderStore = undefined; throw error; });

/** Only the handle activates dragging; editing and CLI icon clicks remain normal buttons. */
function SortableRow({ id, disabled, children }: { id: string; disabled: boolean; children: (handle: ReactNode) => ReactNode }) {
  const { t } = useI18n();
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id, disabled });
  const handle = <ActionIcon ref={setActivatorNodeRef} {...attributes} {...listeners} disabled={disabled}
    variant="subtle" color="gray" size="sm" style={{ touchAction: "none", cursor: disabled ? "default" : "grab", flexShrink: 0 }}
    aria-label={t("extensions.sort.drag")} title={t("extensions.sort.drag")}><GripVertical size={17} /></ActionIcon>;
  return <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, position: "relative", zIndex: isDragging ? 1 : undefined }}
    className="min-w-0">{children(handle)}</div>;
}

/** Persist only presentation IDs, independently from MCP native save and installation state. */
export function ExtensionSortableList<T>({ items, itemId, kind, disabled = false, children }: {
  items: T[]; itemId: (item: T) => string; kind: "mcp" | "skills"; disabled?: boolean; children: (item: T, handle: ReactNode) => ReactNode;
}) {
  const { t } = useI18n();
  const [order, setOrder] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  useEffect(() => {
    let stale = false;
    setReady(false);
    void getOrderStore().then(store => store.get<unknown>(kind)).then(value => {
      if (!stale) setOrder(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
    }).catch(() => { if (!stale) toast.error(t("extensions.sort.failed")); })
      .finally(() => { if (!stale) setReady(true); });
    return () => { stale = true; };
  }, [kind, t]);
  const ranks = new Map(order.map((id, index) => [id, index]));
  const sorted = [...items].sort((a, b) => (ranks.get(itemId(a)) ?? order.length) - (ranks.get(itemId(b)) ?? order.length));
  const ids = sorted.map(itemId);
  const blocked = disabled || !ready || saving;
  return <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => {
    if (blocked || !over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id)), to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(ids, from, to), previous = order;
    setOrder(next); setSaving(true);
    void getOrderStore().then(async store => { await store.set(kind, next); await store.save(); })
      .catch(() => { setOrder(previous); toast.error(t("extensions.sort.failed")); })
      .finally(() => setSaving(false));
  }}>
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      <div className="flex flex-col gap-3">{sorted.map(item => <SortableRow key={itemId(item)} id={itemId(item)} disabled={blocked || items.length < 2}>
        {handle => children(item, handle)}
      </SortableRow>)}</div>
    </SortableContext>
  </DndContext>;
}
