export type Profile = { id: string; full_name: string; employee_code: string; username: string; role: 'admin' | 'employee'; department: string | null; is_active: boolean };
export type Attendance = { id: string; employee_id: string; work_date: string; time_in: string; status: 'present' | 'late'; profiles?: Pick<Profile,'full_name'|'employee_code'|'department'> };
