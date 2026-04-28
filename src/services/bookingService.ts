import { supabase } from '../lib/supabase'

export const getBookingByTrackingId = async (trackingId: string) => {
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('tracking_id', trackingId)
    .single()
    
  if (error) {
    console.error(`Error fetching tracking ID ${trackingId}:`, error.message)
    return null
  }
  return data
}

export const getBookingsByPhone = async (phone: string) => {
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('sender_phone', phone)
    .order('created_at', { ascending: false })
    .limit(5)
    
  if (error) {
    console.error(`Error fetching bookings for phone ${phone}:`, error.message)
    return []
  }
  return data || []
}

export const getBookingsByUserId = async (userId: string) => {
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(5)
    
  if (error) {
    console.error(`Error fetching bookings for user ${userId}:`, error.message)
    return []
  }
  return data || []
}
