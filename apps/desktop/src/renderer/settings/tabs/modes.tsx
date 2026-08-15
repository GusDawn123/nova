import { useState, type JSX, type ReactNode } from "react";

import { ChatIcon, DocIcon } from "../../design/icons";
import { GENERAL_MODE, NOVA_MODES } from "../../design/modes";
import { CompassIcon, DemoIcon, PlusIcon, ScalesIcon } from "../icons";

/** Each sales mode's sidebar glyph, from the mockup. General uses the doc. */
const MODE_ICONS: Record<string, ReactNode> = {
  discovery: <CompassIcon />,
  demo: <DemoIcon />,
  objection: <ChatIcon size={18} />,
  negotiation: <ScalesIcon />,
};

/**
 * The Modes tab: sidebar of modes, a detail pane, and Set Active. Selection
 * and activation are presentational until modes are wired to the live session.
 */
export function ModesTab(): JSX.Element {
  const [selected, setSelected] = useState("general");
  const [active, setActive] = useState("general");

  const current =
    NOVA_MODES.find((mode) => mode.id === selected) ?? GENERAL_MODE;
  const isActive = active === selected;

  return (
    <>
      <div className="modes">
        <div className="modes__sidebar">
          <button type="button" className="modes__item modes__item--new">
            <span className="modes__item-icon">
              <PlusIcon />
            </span>
            <span className="modes__item-name">New Mode</span>
          </button>

          <ModeItem
            icon={<DocIcon size={18} />}
            name="General"
            selected={selected === "general"}
            onSelect={() => {
              setSelected("general");
            }}
          />

          <div className="modes__group">
            <span className="modes__group-label">Sales</span>
            <span className="modes__group-line" />
          </div>

          {NOVA_MODES.filter((mode) => mode.id !== "general").map((mode) => (
            <ModeItem
              key={mode.id}
              icon={MODE_ICONS[mode.id]}
              name={mode.name}
              selected={selected === mode.id}
              onSelect={() => {
                setSelected(mode.id);
              }}
            />
          ))}
        </div>

        <div className="modes__detail">
          <div className="modes__detail-title">{current.name}</div>
          <div className="modes__detail-desc">{current.desc}</div>
        </div>
      </div>

      <div className="modes__footer">
        <button
          type="button"
          className={
            isActive
              ? "modes__set-active modes__set-active--active"
              : "modes__set-active"
          }
          onClick={() => {
            setActive(selected);
          }}
        >
          {isActive ? "Active ✓" : "Set Active"}
        </button>
      </div>
    </>
  );
}

function ModeItem({
  icon,
  name,
  selected,
  onSelect,
}: {
  readonly icon: ReactNode;
  readonly name: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={selected ? "modes__item modes__item--selected" : "modes__item"}
      onClick={onSelect}
    >
      <span className="modes__item-icon">{icon}</span>
      <span className="modes__item-name">{name}</span>
    </button>
  );
}
