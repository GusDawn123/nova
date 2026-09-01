import type { JSX, ReactNode } from "react";

import { CheckIcon } from "../design/icons";

/**
 * The pill's dropdown menu, extracted (Gustavo, 2026-08-20) so every picker —
 * modes, models, whatever comes next — is a data list, not a rebuilt block of
 * JSX. Visuals stay the ratified mockup's `mode-menu` classes; a new menu is
 * a new `items` array and nothing else. `footer` carries anything below the
 * list (the mode menu's divider + Manage row).
 */

export interface PillMenuItem<Id extends string = string> {
  readonly id: Id;
  readonly name: string;
}

export interface PillMenuProps<Id extends string> {
  readonly items: readonly PillMenuItem<Id>[];
  readonly activeId: string;
  readonly onPick: (id: Id) => void;
  readonly footer?: ReactNode;
}

export function PillMenu<Id extends string>(
  props: PillMenuProps<Id>,
): JSX.Element {
  return (
    <div className="mode-menu nd">
      {props.items.map((item) => (
        <button
          type="button"
          key={item.id}
          className="mode-menu__item"
          onClick={() => {
            props.onPick(item.id);
          }}
        >
          <span className="mode-menu__name">{item.name}</span>
          {item.id === props.activeId && <CheckIcon />}
        </button>
      ))}
      {props.footer}
    </div>
  );
}
