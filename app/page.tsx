'use client';

import Link from 'next/link';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-600 to-indigo-700 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full p-8">
        <h1 className="text-4xl font-bold text-purple-600 mb-4">
          🚀 HandlePay Onboarding PoC
        </h1>
        <div className="mt-8 p-4 bg-slate-100 rounded-lg">
          <p className="text-sm text-slate-600 font-mono">
            <span className="font-semibold">API:</span> {API_BASE}
          </p>
          <p className="text-xs text-slate-500 mt-2">
            Make sure the backend is running before testing
          </p>
        </div>
        <p className="text-slate-600 mb-8 mt-8">
          Test the Phase 1 Foundation - Usecases & Username Reservation
        </p>

        <div className="space-y-4">
          <Link
            href="/phase1/onboarding"
            className="block p-6 bg-gradient-to-r from-purple-500 to-indigo-500 rounded-xl shadow-lg hover:shadow-xl transition-all hover:scale-[1.02] group"
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold text-white mb-2">
                  Phase 1: Onboarding Flow
                </h2>
                <p className="text-purple-100">
                  Test usecase selection and username reservation
                </p>
              </div>
              <svg
                className="w-8 h-8 text-white group-hover:translate-x-2 transition-transform"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 7l5 5m0 0l-5 5m5-5H6"
                />
              </svg>
            </div>
          </Link>
        </div>





        <div className="mt-6 border-t pt-6">
          <h3 className="font-semibold text-slate-900 mb-3">Phase 2 - Ready to Test ⚡</h3>
          <Link
            href="/phase2/passkey-test"
            className="block p-4 bg-gradient-to-r from-blue-500 to-cyan-500 rounded-xl shadow-lg hover:shadow-xl transition-all hover:scale-[1.02] group mb-4"
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-white mb-1">
                  🔐 Passkey Authentication
                </h2>
                <p className="text-blue-100 text-sm">
                  Test WebAuthn passkey registration and login
                </p>
              </div>
              <svg
                className="w-6 h-6 text-white group-hover:translate-x-2 transition-transform"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 7l5 5m0 0l-5 5m5-5H6"
                />
              </svg>
            </div>
          </Link>
        </div>

        <div className="mt-6 border-t pt-6">
          <h3 className="font-semibold text-slate-900 mb-3">Phase 3 - & Beyond 🚀</h3>
          <Link
            href="/dashboard"
            className="block p-4 bg-gradient-to-r from-emerald-500 to-teal-500 rounded-xl shadow-lg hover:shadow-xl transition-all hover:scale-[1.02] group mb-4"
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-white mb-1">
                  📊 User Dashboard
                </h2>
                <p className="text-emerald-100 text-sm">
                  View wallet balances and portfolio (Requires Login)
                </p>
              </div>
              <svg
                className="w-6 h-6 text-white group-hover:translate-x-2 transition-transform"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 7l5 5m0 0l-5 5m5-5H6"
                />
              </svg>
            </div>
          </Link>

          <Link
            href="/phase3/wallet-test"
            className="block p-4 bg-gradient-to-r from-slate-500 to-slate-600 rounded-xl shadow-lg hover:shadow-xl transition-all hover:scale-[1.02] group mb-4"
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-white mb-1">
                  Wallet Test (Dev Mode)
                </h2>
                <p className="text-slate-100 text-sm">
                  Legacy: Test EVM wallet creation manually
                </p>
              </div>
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            </div>
          </Link>
        </div>

        <div className="mt-6 border-t pt-6">
          <h3 className="font-semibold text-slate-900 mb-3">Coming Next:</h3>
          <ul className="space-y-2 text-sm text-slate-400">
            <li className="flex items-center gap-2">
              <span>⏳</span> Phase 3: Full Wallet Integration
            </li>
            <li className="flex items-center gap-2">
              <span>⏳</span> Phase 4: Notifications Module
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
