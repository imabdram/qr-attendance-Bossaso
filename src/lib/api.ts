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
  employee_code: string;
  username: string;
  password: string;
  department?: string;
}): Promise<{ success: boolean; message: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('admin-create-employee', {
      body: form,
    });

    if (error) {
      if (
        error.message?.includes('Failed to send a request') ||
        error.message?.includes('FunctionsFetchError')
      ) {
        throw new Error(
          'Edge Function "admin-create-employee" is not yet deployed on Supabase. Please deploy Edge Functions using the Supabase CLI, or create users in the Supabase Dashboard under Authentication -> Users.'
        );
      }
      throw error;
    }

    if (!data?.success) {
      throw new Error(data?.message || 'Could not create employee account.');
    }

    return data;
  } catch (err: any) {
    if (
      err.message?.includes('Failed to send a request') ||
      err.message?.includes('FunctionsFetchError')
    ) {
      throw new Error(
        'Edge Function "admin-create-employee" is not deployed yet. Please deploy the function or create user in Supabase Authentication -> Users.'
      );
    }
    throw err;
  }
}
