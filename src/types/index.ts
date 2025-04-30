export interface Employee {
  id: number;
  name: string;
  eligibleWeekend: boolean; // Can this person have a full D/D weekend?
  preferences: {
    preferWeekendWork?: boolean;
    preferMondayRest?: boolean;
    preferThursdayT?: boolean;
    fixedAssignments?: { date: string; shift: ShiftType }[]; // e.g., Cardozo 24/25 M, Molina 1 M
    fixedDaysOff?: string[]; // e.g., Molina 17/18 D
    fixedWorkShift?: { dayOfWeek: number[]; shift: ShiftType }; // Alamo Mon-Fri M
  };
  history: { // Last 5 days of previous month
    [date: string]: ShiftType | null; // e.g., "2025-04-30": "M"
  };
  consecutiveWorkDays?: number; // Calculated based on history
}

export type ShiftType = "M" | "T" | "D" | "C" | "F" | "LM" | "LAO";

export interface Absence {
  employeeId: number;
  type: "LAO" | "LM";
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
}

export interface Holiday {
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
    D: number;
    C: number;
    F: number;
    LM: number;
    LAO: number;
    TPT: number; // Total Personnel Turning (M+T)
  };
}

export interface EmployeeTotals {
  workedDays: number;
  M: number;
  T: number;
  freeSaturdays: number;
  freeSundays: number;
  F: number;
  C: number;
  D: number;
  LM: number;
  LAO: number;
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
  M: "bg-green-100 text-green-800", // #d4edda
  T: "bg-blue-100 text-blue-800", // #cce5ff
  D: "bg-gray-200 text-gray-700", // #e9ecef
  C: "bg-gray-200 text-gray-700", // #e9ecef
  F: "bg-gray-200 text-gray-700", // #e9ecef
  LM: "bg-red-100 text-red-800", // #f8d7da
  LAO: "bg-red-100 text-red-800", // #f8d7da
};

export const TOTALS_COLOR = "bg-yellow-100 text-yellow-800"; // #fff3cd
