export type Profile = {
  id: string;
  full_name: string;
  employee_number: string;
  username: string;
  role: 'admin' | 'employee';
  department: string | null;
  shift?: 'morning' | 'afternoon';
  is_active: boolean;
};

export type Attendance = {
  id: string;
  employee_id: string;
  work_date: string;
  time_in: string;
  status: 'present' | 'late';
  shift?: 'morning' | 'afternoon';
  profiles?: Pick<Profile, 'full_name' | 'employee_number' | 'department' | 'shift'>;
};
