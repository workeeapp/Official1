import { describe, expect, it } from "vitest";
import type { PublicEmployee } from "@workee/shared";
import { planInvolvedChangeNotices } from "../src/services/chat.service.js";

const human = (id: string, name: string): PublicEmployee => ({
  id,
  kind: "human",
  protected: false,
  name,
  surname: "",
  nickname: null,
  email: null,
  phone: null,
  isOwner: false,
});

const amit = human("amit", "עמית");
const tal = human("tal", "טל");
const eran = human("eran", "ערן");
const guest = human("guest", "אורח");
const humans = [amit, tal, eran, guest];

describe("planInvolvedChangeNotices", () => {
  it("tells everyone else a cancelled worker task involved", () => {
    const notices = planInvolvedChangeNotices({
      actor: tal,
      humans,
      listMutations: [
        {
          action: "remove",
          itemId: "lucy-task",
          employeeId: "lucy",
          listType: "tasks",
          itemKey: "להזכיר לטל לבדוק את התזכורת",
          itemLabel: "להזכיר לטל לבדוק את התזכורת",
          workerTaskInvolvedIds: ["amit", "tal", "eran", "lucy", "guest"],
        },
      ],
      reminderChanges: [],
    });
    expect(notices.map((row) => row.target.id)).toEqual(["amit", "eran"]);
    expect(notices[0]?.text).toBe(
      "התזכורת «להזכיר לטל לבדוק את התזכורת» בוטלה על ידי טל.",
    );
  });

  it("reports a clock time change with the new time, once per person", () => {
    const notices = planInvolvedChangeNotices({
      actor: amit,
      humans,
      listMutations: [],
      reminderChanges: [
        {
          action: "update",
          label: "לבדוק את התזכורת",
          fireAt: "2026-10-09 21:00",
          involvedIds: ["amit", "tal", "tal"],
        },
      ],
    });
    expect(notices).toEqual([
      {
        target: tal,
        text: "התזכורת «לבדוק את התזכורת» עודכנה על ידי עמית — עכשיו ל-2026-10-09 21:00.",
      },
    ]);
  });

  it("sends nothing for a self-nudge only the actor is involved in", () => {
    expect(
      planInvolvedChangeNotices({
        actor: amit,
        humans,
        listMutations: [],
        reminderChanges: [
          {
            action: "remove",
            label: "לקנות חלב",
            fireAt: "2026-10-09 21:00",
            involvedIds: ["amit"],
          },
        ],
      }),
    ).toEqual([]);
  });
});
