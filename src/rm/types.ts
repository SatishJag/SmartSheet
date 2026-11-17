/** Resource management records, as stored in the rm_* tables (0004_resource_management.sql). */

export type OfficeStatus = 'in_office' | 'remote' | 'out_of_office'
export type MemberType = 'employee' | 'contractor' | 'placeholder'
export type ProjectType = 'confirmed' | 'tentative' | 'internal'
export type ProjectState = 'active' | 'archived'
export type BudgetType = 'none' | 'amount' | 'days'
export type AssignmentStatus = 'confirmed' | 'tentative'
export type ViewPage = 'people' | 'schedule' | 'projects'

export interface Person {
  id: string
  first_name: string
  last_name: string
  email: string | null
  role: string | null
  discipline: string | null
  location: string | null
  tags: string[]
  capacity_hours_per_day: number
  bill_rate: number
  office_status: OfficeStatus | null
  member_type: MemberType
  is_approver: boolean
  created_at?: string
}

export interface Project {
  id: string
  name: string
  client: string | null
  project_type: ProjectType
  state: ProjectState
  /** ISO dates (YYYY-MM-DD), inclusive. */
  starts_at: string
  ends_at: string
  project_owner_id: string | null
  budget_type: BudgetType
  budget_amount: number | null
  budget_days: number | null
  tags: string[]
  sheet_id: string | null
  created_at?: string
}

export interface Assignment {
  id: string
  project_id: string
  person_id: string
  starts_at: string
  ends_at: string
  allocation_percent: number
  status: AssignmentStatus
  notes: string | null
  created_at?: string
}

export interface SavedView {
  id: string
  page: ViewPage
  name: string
  state: Record<string, unknown>
  created_at?: string
}

export type PersonInput = Omit<Person, 'id' | 'created_at'>
export type ProjectInput = Omit<Project, 'id' | 'created_at'>
export type AssignmentInput = Omit<Assignment, 'id' | 'created_at'>

export const OFFICE_STATUS_LABELS: Record<OfficeStatus, string> = {
  in_office: 'In office',
  remote: 'Remote',
  out_of_office: 'Out of office',
}

export const MEMBER_TYPE_LABELS: Record<MemberType, string> = {
  employee: 'Employee',
  contractor: 'Contractor',
  placeholder: 'Placeholder',
}

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  confirmed: 'Confirmed',
  tentative: 'Tentative',
  internal: 'Internal',
}

export const fullName = (p: Pick<Person, 'first_name' | 'last_name'>) => `${p.first_name} ${p.last_name}`.trim()

export function blankPerson(): PersonInput {
  return {
    first_name: '',
    last_name: '',
    email: null,
    role: null,
    discipline: null,
    location: null,
    tags: [],
    capacity_hours_per_day: 8,
    bill_rate: 0,
    office_status: null,
    member_type: 'employee',
    is_approver: false,
  }
}

export function blankProject(today: string): ProjectInput {
  return {
    name: '',
    client: null,
    project_type: 'confirmed',
    state: 'active',
    starts_at: today,
    ends_at: today,
    project_owner_id: null,
    budget_type: 'none',
    budget_amount: null,
    budget_days: null,
    tags: [],
    sheet_id: null,
  }
}
