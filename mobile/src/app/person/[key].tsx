import { useEffect, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Appbar, Button, Dialog, List, Menu, Portal, Snackbar, Text } from "react-native-paper";
import { Gallery } from "../../Gallery";
import { FaceAvatar } from "../../Faces";
import { NameDialog } from "../albums";
import { refreshLibrary, useLibrary } from "../../libraryStore";
import { sortByDate } from "../../search/query";
import { forgetPerson, mergeInto, nameGroup, removeFromPerson, setHidden, usePeople } from "../../search/people";
import { useAppTheme } from "../../ui";
import { text } from "../../tokens";
import { t, tn } from "../../i18n";

/** One person's photos, newest first. Name them, say who else they are, hide them, or take photos out. */
export default function PersonScreen() {
  const th = useAppTheme();
  const { key } = useLocalSearchParams<{ key: string }>();
  const { items, error } = useLibrary();
  const { groups, reload } = usePeople();
  useEffect(() => { if (!items) refreshLibrary(); }, []);
  const [current, setCurrent] = useState(key);
  const group = groups?.find((g) => g.key === current || g.person?.id === current);
  const [menu, setMenu] = useState(false);
  const [naming, setNaming] = useState(false);
  const [merging, setMerging] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // after naming, the group's key becomes the person's id
  useEffect(() => { if (group?.person && current !== group.person.id) setCurrent(group.person.id); }, [group?.person?.id]);

  const shown = useMemo(() => {
    if (!groups || !items) return null;
    if (!group) return []; // not found anymore (hidden, joined with someone): no badge for ever
    const ids = new Set(group.items);
    return sortByDate(items.filter((i) => ids.has(i.id) && !i.broken));
  }, [group, groups, items]);

  const name = group?.person?.name;
  const others = (groups ?? []).filter((g) => g.person?.name && g.key !== group?.key);
  const act = async (f: () => Promise<void>, msg?: string) => {
    try { await f(); reload(); if (msg) setNote(msg); } catch (e) { setNote(e instanceof Error ? e.message : t("That didn't work.")); }
  };

  return (
    <View style={{ flex: 1 }}>
      <Gallery
        items={shown} error={error} loading={!groups} onRefresh={reload} within="person"
        header={
          <Appbar.Header style={{ backgroundColor: th.colors.background }}>
            <Appbar.Action icon="back" accessibilityLabel={t("Back")} onPress={() => router.back()} />
            <Appbar.Content title={name || t("Add a name")} titleStyle={{ ...text.page, color: name ? th.colors.onSurface : th.colors.primary }} onPress={() => setNaming(true)} />
            <Menu visible={menu} onDismiss={() => setMenu(false)} anchor={<Appbar.Action icon="more" accessibilityLabel={t("More")} onPress={() => setMenu(true)} />}>
              <Menu.Item title={name ? t("Rename") : t("Add a name")} onPress={() => { setMenu(false); setNaming(true); }} />
              {others.length ? <Menu.Item title={t("Same person as…")} onPress={() => { setMenu(false); setMerging(true); }} /> : null}
              {group ? <Menu.Item title={group.person?.hidden ? t("Show again") : t("Hide this person")} onPress={() => { setMenu(false); act(async () => { setCurrent(await setHidden(group, !group.person?.hidden)); }, group.person?.hidden ? t("Shown again.") : t("Hidden from search and People.")); }} /> : null}
              {group?.person ? <Menu.Item title={t("Forget the name")} onPress={() => { setMenu(false); act(() => forgetPerson(group.person!), t("Name removed.")); }} /> : null}
            </Menu>
          </Appbar.Header>
        }
        extraAction={group?.person ? {
          icon: "x", label: group.person.name ? t("Not {name}", { name: group.person.name }) : t("Not this person"),
          run: async (ids) => {
            const pick = new Set(ids);
            await removeFromPerson(group.person!, group.faces.filter((f) => pick.has(f.split(":")[0])));
            reload();
            return tn(ids.length, "Removed from this person.", "{n} photos removed from this person.");
          },
        } : undefined}
        empty={<View style={{ padding: 32 }}><Text variant="bodyMedium" style={{ textAlign: "center", color: th.colors.onSurfaceVariant }}>{t("No photos of this person.")}</Text></View>}
      />
      <Portal>
        <NameDialog visible={naming} title={name ? t("Rename") : t("Who is this?")} action={t("Save")} initial={name ?? ""} onDismiss={() => setNaming(false)}
          onSubmit={async (n) => {
            // the name is someone already there: then these are the same person
            const same = others.find((g) => g.person!.name.toLowerCase() === n.trim().toLowerCase());
            if (same && group) { await mergeInto(group, same.person!); setCurrent(same.person!.id); }
            else if (group) { const id = await nameGroup(group, n); if (id) setCurrent(id); }
            setNaming(false); reload();
          }} />
        <Dialog visible={merging} onDismiss={() => setMerging(false)} style={{ maxHeight: "80%" }}>
          <Dialog.Title>{t("Same person as")}</Dialog.Title>
          <Dialog.ScrollArea style={{ paddingHorizontal: 0 }}>
            <ScrollView>
              {others.map((g) => (
                <List.Item key={g.key} title={g.person!.name} description={tn(g.items.length, "{n} photo", "{n} photos")}
                  left={() => <View style={{ marginLeft: 8 }}><FaceAvatar group={g} size={40} onPress={() => {}} /></View>}
                  onPress={() => { setMerging(false); if (group) act(async () => { await mergeInto(group, g.person!); setCurrent(g.person!.id); }, t("Joined with {name}.", { name: g.person!.name })); }} />
              ))}
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Actions><Button onPress={() => setMerging(false)}>{t("Cancel")}</Button></Dialog.Actions>
        </Dialog>
      </Portal>
      <Snackbar visible={!!note} onDismiss={() => setNote(null)} duration={4000}>{note}</Snackbar>
    </View>
  );
}
