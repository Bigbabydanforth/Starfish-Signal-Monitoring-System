/**
 * hubspot/enrollInSequence.js
 *
 * C4 — Single-responsibility function: enroll one HubSpot contact into one sequence.
 * This is the only file that calls the HubSpot Sequences enrollment API.
 * Called exclusively by enrollmentQueue.js — do not call directly from workflow files.
 *
 * ENV VARS REQUIRED:
 *   HUBSPOT_PRIVATE_APP_TOKEN
 *
 * HubSpot API:
 *   POST /automation/v4/sequences/enrollments
 *   userId in enrolledBy is the HubSpot owner/user ID (same ID as DAVID/ZACK_HUBSPOT_OWNER_ID).
 */

import 'dotenv/config';
import axios from 'axios';

const HUBSPOT_TOKEN    = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const HUBSPOT_BASE_URL = 'https://api.hubapi.com';

/**
 * Enroll a single contact in a HubSpot sequence.
 *
 * @param {string} contactId  - HubSpot contact ID (numeric string)
 * @param {string} sequenceId - HubSpot sequence ID (numeric string)
 * @param {string} userId     - HubSpot owner/user ID — determines who the email sends from
 * @returns {Promise<{
 *   success: boolean,
 *   enrollmentId?: string,
 *   alreadyEnrolled?: boolean,
 *   error?: string,
 *   status?: number
 * }>}
 *   Never throws — all errors are returned in the result object.
 */
export async function enrollInSequence(contactId, sequenceId, userId) {
  if (!HUBSPOT_TOKEN) {
    return { success: false, error: 'HUBSPOT_PRIVATE_APP_TOKEN not set', status: null };
  }
  if (!contactId || !sequenceId) {
    return { success: false, error: `Missing required field: ${!contactId ? 'contactId' : 'sequenceId'}`, status: null };
  }

  try {
    const response = await axios.post(
      `${HUBSPOT_BASE_URL}/automation/v4/sequences/enrollments`,
      {
        sequenceId,
        contactId,
        ...(userId ? { enrolledBy: { userId } } : {}),
      },
      {
        headers: {
          Authorization:  `Bearer ${HUBSPOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    return { success: true, enrollmentId: response.data?.id || null };

  } catch (err) {
    const status  = err.response?.status;
    const message = err.response?.data?.message || err.message;

    // 409 — contact is already enrolled in this sequence — treat as success
    if (status === 409) {
      return { success: true, alreadyEnrolled: true };
    }

    return { success: false, error: message, status };
  }
}
