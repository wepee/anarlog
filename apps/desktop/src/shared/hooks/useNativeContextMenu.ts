import {
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
} from "@tauri-apps/api/menu";
import { type MouseEvent, useCallback } from "react";

type MenuActionDef = {
  id: string;
  text: string;
  action: () => void;
  disabled?: boolean;
  accelerator?: string;
};

export type MenuItemDef =
  | MenuActionDef
  | { id: string; text: string; items: MenuActionDef[]; disabled?: boolean }
  | { separator: true };

async function buildMenuItem(
  item: MenuItemDef,
): Promise<MenuItem | PredefinedMenuItem | Submenu> {
  if ("separator" in item) {
    return PredefinedMenuItem.new({ item: "Separator" });
  }

  if ("items" in item) {
    return Submenu.new({
      id: item.id,
      text: item.text,
      enabled: !item.disabled,
      items: await Promise.all(item.items.map(buildMenuItem)),
    });
  }

  return MenuItem.new({
    id: item.id,
    text: item.text,
    enabled: !item.disabled,
    accelerator: item.accelerator,
    action: item.action,
  });
}

async function showNativeContextMenu(items: MenuItemDef[], e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();

  const menuItems = await Promise.all(items.map(buildMenuItem));

  const menu = await Menu.new({ items: menuItems });
  await menu.popup();
}

export function useNativeContextMenu(items: MenuItemDef[]) {
  const showMenu = useCallback(
    async (e: MouseEvent) => {
      await showNativeContextMenu(items, e);
    },
    [items],
  );

  return showMenu;
}
