/**
 * Fixture members. Entirely synthetic — no real people, no real account numbers.
 *
 * Three of these exist to produce *business outcomes* rather than errors, which is
 * the distinction the whole replay result contract turns on:
 *
 *   12345  happy path
 *   23456  happy path, different balances (proves outputs are really extracted)
 *   55555  restricted — a permission denial the caller must be told about
 *   99999  absent — "no such member", a legitimate answer and not a crash
 */

export type AccountKind = "Savings" | "Checking" | "Money Market"

export interface Account {
  readonly kind: AccountKind
  readonly number: string
  readonly balance: number
  readonly opened: string
}

export interface Member {
  readonly id: string
  readonly name: string
  readonly status: "active" | "restricted"
  readonly branch: string
  readonly accounts: readonly Account[]
  /** Sub-accounts opened during this process run. Reset by the control endpoint. */
  subAccounts: Account[]
}

const seed = (): Member[] => [
  {
    id: "12345",
    name: "Dana Whitfield",
    status: "active",
    branch: "Downtown",
    accounts: [
      {
        kind: "Savings",
        number: "S-0001-12345",
        balance: 4812.65,
        opened: "2019-03-11",
      },
      {
        kind: "Checking",
        number: "C-0002-12345",
        balance: 1204.1,
        opened: "2019-03-11",
      },
    ],
    subAccounts: [],
  },
  {
    id: "23456",
    name: "Marcus Ellery",
    status: "active",
    branch: "Northgate",
    accounts: [
      {
        kind: "Savings",
        number: "S-0001-23456",
        balance: 250.0,
        opened: "2021-07-02",
      },
      {
        kind: "Money Market",
        number: "M-0003-23456",
        balance: 15980.42,
        opened: "2022-01-19",
      },
    ],
    subAccounts: [],
  },
  {
    id: "55555",
    name: "Priya Raman",
    status: "restricted",
    branch: "Downtown",
    accounts: [
      {
        kind: "Savings",
        number: "S-0001-55555",
        balance: 9100.0,
        opened: "2017-11-30",
      },
    ],
    subAccounts: [],
  },
]

let members: Member[] = seed()

export const findMember = (id: string): Member | undefined =>
  members.find((member) => member.id === id.trim())

export const resetMembers = (): void => {
  members = seed()
}

/** Next sub-account number for a member, in the vendor's format. */
export const nextSubAccountNumber = (member: Member): string => {
  const index = member.accounts.length + member.subAccounts.length + 1
  return `S-${String(index).padStart(4, "0")}-${member.id}`
}

export const formatCurrency = (amount: number): string =>
  amount.toLocaleString("en-US", { style: "currency", currency: "USD" })
