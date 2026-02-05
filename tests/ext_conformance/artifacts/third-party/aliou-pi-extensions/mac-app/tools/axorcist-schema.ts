import { type Static, Type } from "@sinclair/typebox";

export const Criterion = Type.Object({
  attribute: Type.String({
    description: "AX attribute name (e.g., AXTitle, AXRole, AXIdentifier)",
  }),
  value: Type.String({ description: "Value to match" }),
  matchType: Type.Optional(
    Type.Union(
      [
        Type.Literal("exact"),
        Type.Literal("contains"),
        Type.Literal("regex"),
        Type.Literal("containsAny"),
        Type.Literal("prefix"),
        Type.Literal("suffix"),
      ],
      { description: "Match type (default: exact)" },
    ),
  ),
});

export const Locator = Type.Object({
  criteria: Type.Array(Criterion, {
    description: "Match criteria (AND by default)",
  }),
  matchAll: Type.Optional(
    Type.Boolean({
      description: "Require all criteria to match (default: true)",
      default: true,
    }),
  ),
});

export type CriterionType = Static<typeof Criterion>;
export type LocatorType = Static<typeof Locator>;
