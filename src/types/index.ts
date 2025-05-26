

export interface Employee {
  id: number;
  name: string;
  eligibleWeekend: boolean; // Can this person have a full D/D weekend?
  preferences: { // Made non-optional for easier handling, ensure default empty object is provided
    preferWeekendWork?: boolean;
    fixedAssignments?: { date: string; shift: ShiftType }[]; // e.g., Cardozo 24/25 M, Molina 1 M
    fixedWorkShift?: { dayOfWeek: number[]; shift: ShiftType }; // Alamo Mon-Fri M
  };
  history: { // Last 5 days of previous month
    [date: string]: ShiftType | null; // e.g., "2025-04-30": "M"
  };
  consecutiveWorkDays?: number; // Calculated based on history
}

export type ShiftType = "M" | "T" | "N" | "D" | "F" | "LM" | "LAO" | "C";
export const SHIFT_TYPES: ShiftType[] = ["M", "T", "N", "D", "F", "LM", "LAO", "C"];

// Define the allowed shift types for fixed assignments, including 'D' and 'C'
export const ALLOWED_FIXED_ASSIGNMENT_SHIFTS: ShiftType[] = ["M", "T", "N", "D", "C"];


export interface Absence {
  id?: number; // Optional ID for client-side management
  employeeId: number;
  type: "LAO" | "LM";
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
}

export interface Holiday {
  id?: number; // Optional ID for client-side management
  date: string; // YYYY-MM-DD
  description: string;
}

export interface ScheduleDay {
  date: string; // YYYY-MM-DD
  isWeekend: boolean;
  isHoliday: boolean;
  shifts: {
    [employeeId: number]: ShiftType | null;
  };
  totals: {
    M: number;
    T: number;
    N: number; // Added for Night shift
    D: number;
    F: number;
    LM: number;
    LAO: number;
    C: number;
    TPT: number; // Total Personnel Turning (M+T), or M+T+N if desired later
  };
}

export interface EmployeeTotals {
  workedDays: number;
  M: number;
  T: number;
  N: number; // Added for Night shift
  freeSaturdays: number;
  freeSundays: number;
  F: number;
  D: number;
  LM: number;
  LAO: number;
  C: number;
}

export interface Schedule {
  month: number; // 1-12
  year: number;
  days: ScheduleDay[];
  employeeTotals: {
    [employeeId: number]: EmployeeTotals;
  };
}

export interface ValidationResult {
  rule: string;
  passed: boolean;
  details?: string; // Explanation if failed or noteworthy details
}

export interface ScheduleReport {
  validations: ValidationResult[];
  generationTimeMs?: number; // Optional: time taken to generate
}

export const SHIFT_COLORS: Record<ShiftType, string> = {
  M: "bg-green-100 text-green-800",
  T: "bg-blue-100 text-blue-800",
  N: "bg-indigo-100 text-indigo-800", // Color for Night shift
  D: "bg-green-100 text-green-800",
  F: "bg-purple-100 text-purple-800",
  LM: "bg-amber-100 text-amber-800",
  LAO: "bg-amber-100 text-amber-800",
  C: "bg-teal-100 text-teal-800",
};

export const TOTALS_COLOR = "bg-yellow-100 text-yellow-800";

export interface TargetStaffing {
  workdayMorning: number;
  workdayAfternoon: number;
  workdayNight: number; // Added for Night shift
  weekendHolidayMorning: number;
  weekendHolidayAfternoon: number;
  weekendHolidayNight: number; // Added for Night shift
}

export interface OperationalRules {
  requiredDdWeekends: number;
  minCoverageTPT: number;
  minCoverageM: number;
  minCoverageT: number;
  minCoverageN: number; // Added for Night shift
}
