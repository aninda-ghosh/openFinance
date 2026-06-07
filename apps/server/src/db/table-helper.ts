/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  pgTable as pgTableReal,
  text as pgText,
  integer as pgInteger,
  boolean as pgBoolean,
  doublePrecision as pgDouble,
} from "drizzle-orm/pg-core";
import {
  sqliteTable as sqliteTableReal,
  text as sqText,
  integer as sqInteger,
  real as sqReal,
} from "drizzle-orm/sqlite-core";

const isSqlite =
  process.env.DB_DIALECT === "sqlite" ||
  !process.env.DATABASE_URL ||
  process.env.OPENFINANCE_DESKTOP === "true";

export const pgTable = (name: string, columns: any): any => {
  return isSqlite ? sqliteTableReal(name, columns) : pgTableReal(name, columns);
};

export const text = (name: string): ReturnType<typeof pgText> => {
  return (isSqlite ? sqText(name) : pgText(name)) as any;
};

export const integer = (name: string): ReturnType<typeof pgInteger> => {
  return (isSqlite ? sqInteger(name) : pgInteger(name)) as any;
};

export const boolean = (name: string): ReturnType<typeof pgBoolean> => {
  return (isSqlite ? sqInteger(name, { mode: "boolean" }) : pgBoolean(name)) as any;
};

export const doublePrecision = (name: string): ReturnType<typeof pgDouble> => {
  return (isSqlite ? sqReal(name) : pgDouble(name)) as any;
};
