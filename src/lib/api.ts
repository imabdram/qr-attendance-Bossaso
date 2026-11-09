import { supabase } from './supabase';

export async function generateQrToken(
  durationSeconds: number = 45
): Promise<{ token: string; expires_at: string }> {
  // 1. Try Edge Function if deployed
  try {
    const { data, error } = await supabase.functions.invoke('create-qr-token', {
      body: { duration_seconds: durationSeconds },
    });
    if (!error && data?.token) {
      return data;
    }
  } catch (_e) {
    // Edge function not available, continue to database RPC
  }

  // 2. High-performance fallback: PostgreSQL RPC function
  const { data: rpcData, error: rpcError } = await supabase.rpc('create_qr_token', {
    p_duration_seconds: durationSeconds,
  });
  if (rpcError) {
    throw new Error(
      rpcError.message ||
        'Could not generate QR code. Please ensure 001_initial_schema.sql was run in Supabase SQL editor.'
    );
  }

  if (rpcData?.error) {
    throw new Error(rpcData.error);
  }

  if (!rpcData?.token) {
    throw new Error('Unable to generate QR code token.');
  }

  return rpcData;
}

export async function recordAttendance(token: string): Promise<{
  success: boolean;
  message: string;
  time_in?: string;
  status?: string;
  already_recorded?: boolean;
}> {
  // 1. Try Edge Function if deployed
  try {
    const { data, error } = await supabase.functions.invoke('scan-attendance', {
      body: { token },
    });
    if (!error && data) {
      return data;
    }
  } catch (_e) {
    // Fallback to database RPC
  }

  // 2. High-performance fallback: PostgreSQL RPC function
  const { data: rpcData, error: rpcError } = await supabase.rpc('scan_attendance', {
    p_token: token,
  });

  if (rpcError) {
    throw new Error(
      rpcError.message || 'Error recording attendance. Please verify your database connection.'
    );
  }

  return rpcData;
}

export async function createEmployeeAccount(form: {
  full_name: string;
  employee_number: string;
  username: string;
  password: string;
  role?: 'admin' | 'employee';
  shift?: 'morning' | 'afternoon';
  department?: string;
}): Promise<{ success: boolean; message: string }> {
  // 1. Try PostgreSQL RPC function first (Zero dependencies, fast, guaranteed without Edge Function)
  try {
    const { data: rpcData, error: rpcError } = await supabase.rpc('admin_create_user', {
      p_full_name: form.full_name,
      p_employee_number: form.employee_number,
      p_username: form.username,
      p_password: form.password,
      p_role: form.role || 'employee',
      p_shift: form.shift || 'morning',
      p_department: form.department || null,
    });

    if (!rpcError && rpcData) {
      if (!rpcData.success) {
        throw new Error(rpcData.message || 'Could not create account.');
      }
      return rpcData;
    }
  } catch (rpcErr: any) {
    // If error is not a function-missing error (like duplicate code/username), propagate it
    if (rpcErr.message && !rpcErr.message.includes('function') && !rpcErr.message.includes('not find')) {
      throw rpcErr;
    }
  }

  // 2. Fallback to Edge Function if deployed
  try {
    const { data, error } = await supabase.functions.invoke('admin-create-employee', {
      body: form,
    });

    if (error) {
      throw error;
    }

    if (!data?.success) {
      throw new Error(data?.message || 'Could not create account.');
    }

    return data;
  } catch (err: any) {
    throw new Error(
      err.message || 'Could not create account. Please ensure migration 005 was run in the Supabase SQL editor.'
    );
  }
}

export async function adminDeleteEmployee(
  employeeId: string
): Promise<{ success: boolean; message: string }> {
  const { data, error } = await supabase.rpc('admin_delete_employee', {
    p_employee_id: employeeId,
  });
  if (error) throw new Error(error.message);
  if (!data?.success) throw new Error(data?.message || 'Could not delete employee.');
  return data;
}

export async function adminResetPassword(
  employeeId: string,
  newPassword: string
): Promise<{ success: boolean; message: string }> {
  const { data, error } = await supabase.rpc('admin_reset_password', {
    p_employee_id: employeeId,
    p_new_password: newPassword,
  });
  if (error) throw new Error(error.message);
  if (!data?.success) throw new Error(data?.message || 'Could not reset password.');
  return data;
}

export async function adminUpdateEmployee(
  employeeId: string,
  form: { full_name: string; employee_number: string; department?: string; shift?: 'morning' | 'afternoon' }
): Promise<{ success: boolean; message: string }> {
  const { data, error } = await supabase.rpc('admin_update_employee', {
    p_employee_id: employeeId,
    p_full_name: form.full_name,
    p_employee_number: form.employee_number,
    p_department: form.department || null,
    p_shift: form.shift || 'morning',
  });
  if (error) throw new Error(error.message);
  if (!data?.success) throw new Error(data?.message || 'Could not update employee.');
  return data;
}
