'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

const API_BASE = 'http://localhost:3001/api/v1';

interface Usecase {
    id: string;
    name: string;
    description?: string;
    icon: string;
    order: number;
    isActive: boolean;
    isRecommended: boolean;
}

export default function OnboardingPage() {
    const [usecases, setUsecases] = useState<Usecase[]>([]);
    const [selectedUsecase, setSelectedUsecase] = useState<Usecase | null>(null);
    const [username, setUsername] = useState('');
    const [usernameValid, setUsernameValid] = useState(false);
    const [usernameAvailable, setUsernameAvailable] = useState(false);
    const [checking, setChecking] = useState(false);
    const [reserving, setReserving] = useState(false);
    const [checkMessage, setCheckMessage] = useState('');
    const [reservationResult, setReservationResult] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadUsecases();
    }, []);

    useEffect(() => {
        const isValid = /^[a-zA-Z0-9_]{3,20}$/.test(username);
        setUsernameValid(isValid);
        if (!isValid && username) {
            setCheckMessage('Invalid format. Use 3-20 characters (letters, numbers, underscore)');
        } else {
            setCheckMessage('');
        }
        setUsernameAvailable(false);
        setReservationResult(null);
    }, [username]);

    const loadUsecases = async () => {
        try {
            const response = await fetch(`${API_BASE}/onboarding/usecases`);

            if (!response.ok) {
                console.error('Failed to fetch usecases:', response.status, response.statusText);
                setLoading(false);
                return;
            }

            const data = await response.json();
            console.log('Usecases loaded:', data); // Debug log
            setUsecases(data);
        } catch (error) {
            console.error('Error loading usecases:', error);
        } finally {
            setLoading(false);
        }
    };

    const checkUsername = async () => {
        if (!usernameValid) return;

        setChecking(true);
        setCheckMessage('');
        setUsernameAvailable(false);

        try {
            const response = await fetch(`${API_BASE}/onboarding/check-username`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username }),
            });

            const result = await response.json();
            setUsernameAvailable(result.available);
            setCheckMessage(result.message);
        } catch (error) {
            setCheckMessage('Failed to check username');
        } finally {
            setChecking(false);
        }
    };

    const reserveUsername = async () => {
        if (!selectedUsecase || !usernameAvailable) return;

        setReserving(true);

        try {
            const response = await fetch(`${API_BASE}/onboarding/reserve-username`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username,
                    usecaseId: selectedUsecase.id,
                }),
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message);
            }

            const result = await response.json();
            setReservationResult(result);
        } catch (error: any) {
            setCheckMessage(error.message || 'Failed to reserve username');
        } finally {
            setReserving(false);
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-purple-600 to-indigo-700 p-4 py-12">
            <div className="max-w-3xl mx-auto">
                <Link
                    href="/"
                    className="inline-flex items-center gap-2 text-white mb-6 hover:underline"
                >
                    ← Back to Home
                </Link>

                <div className="bg-white rounded-2xl shadow-2xl p-8">
                    <h1 className="text-3xl font-bold text-purple-600 mb-2">
                        Onboarding Flow Test
                    </h1>
                    <p className="text-slate-600 mb-8">
                        Complete username reservation process
                    </p>

                    {/* Step 1: Select Usecase */}
                    <div className="mb-8 p-6 bg-slate-50 rounded-xl border-2 border-slate-200">
                        <div className="flex items-center gap-3 mb-4">
                            <span className="w-8 h-8 rounded-full bg-purple-600 text-white flex items-center justify-center text-sm font-bold">
                                1
                            </span>
                            <h2 className="text-xl font-semibold text-slate-900">
                                Select Your Usecase
                            </h2>
                        </div>

                        {loading ? (
                            <div className="text-center py-8 text-slate-600">
                                Loading usecases...
                            </div>
                        ) : usecases.length === 0 ? (
                            <div className="text-center py-8 text-slate-600">
                                No usecases available. Create some in the admin dashboard!
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                                {usecases.map((usecase) => (
                                    <button
                                        key={usecase.id}
                                        onClick={() => setSelectedUsecase(usecase)}
                                        className={`p-4 rounded-xl border-2 transition-all ${selectedUsecase?.id === usecase.id
                                            ? 'border-purple-500 bg-purple-50'
                                            : 'border-slate-200 hover:border-purple-300'
                                            }`}
                                    >
                                        <div className="text-3xl mb-2">{usecase.icon}</div>
                                        <div className="text-sm font-semibold text-slate-900">
                                            {usecase.name}
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Step 2: Check Username */}
                    <div className="mb-8 p-6 bg-slate-50 rounded-xl border-2 border-slate-200">
                        <div className="flex items-center gap-3 mb-4">
                            <span className="w-8 h-8 rounded-full bg-purple-600 text-white flex items-center justify-center text-sm font-bold">
                                2
                            </span>
                            <h2 className="text-xl font-semibold text-slate-900">
                                Choose Username
                            </h2>
                        </div>

                        <div className="mb-4">
                            <label className="block text-sm font-medium text-slate-700 mb-2">
                                Username (3-20 characters, alphanumeric + underscore)
                            </label>
                            <input
                                type="text"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                placeholder="e.g., john_doe"
                                className="w-full px-4 py-3 border-2 border-slate-300 rounded-lg focus:border-purple-500 focus:outline-none transition-colors text-slate-900"
                            />
                        </div>

                        <button
                            onClick={checkUsername}
                            disabled={!usernameValid || checking}
                            className="w-full bg-purple-600 text-white py-3 rounded-lg font-semibold hover:bg-purple-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
                        >
                            {checking ? 'Checking...' : 'Check Availability'}
                        </button>

                        {checkMessage && (
                            <div
                                className={`mt-4 p-3 rounded-lg text-sm ${usernameAvailable
                                    ? 'bg-green-50 text-green-700 border border-green-200'
                                    : 'bg-red-50 text-red-700 border border-red-200'
                                    }`}
                            >
                                {usernameAvailable ? '✅' : '❌'} {checkMessage}
                            </div>
                        )}
                    </div>

                    {/* Step 3: Reserve Username */}
                    <div className="p-6 bg-slate-50 rounded-xl border-2 border-slate-200">
                        <div className="flex items-center gap-3 mb-4">
                            <span className="w-8 h-8 rounded-full bg-purple-600 text-white flex items-center justify-center text-sm font-bold">
                                3
                            </span>
                            <h2 className="text-xl font-semibold text-slate-900">
                                Reserve Username
                            </h2>
                        </div>

                        <button
                            onClick={reserveUsername}
                            disabled={!selectedUsecase || !usernameAvailable || reserving || !!reservationResult}
                            className="w-full bg-purple-600 text-white py-3 rounded-lg font-semibold hover:bg-purple-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
                        >
                            {reserving
                                ? 'Reserving...'
                                : reservationResult
                                    ? 'Username Reserved ✓'
                                    : 'Reserve Username (30 min)'}
                        </button>

                        {reservationResult && (
                            <div className="mt-4 space-y-3">
                                <div className="p-3 bg-green-50 text-green-700 rounded-lg border border-green-200 text-sm">
                                    ✅ {reservationResult.message}
                                </div>

                                <div className="p-4 bg-white rounded-lg border-2 border-slate-200">
                                    <div className="text-xs text-slate-500 mb-1">
                                        Reservation Token:
                                    </div>
                                    <div className="font-mono text-xs text-slate-900 break-all">
                                        {reservationResult.reservationToken}
                                    </div>
                                </div>

                                <div className="p-4 bg-white rounded-lg border-2 border-slate-200">
                                    <div className="text-xs text-slate-500 mb-1">Expires At:</div>
                                    <div className="font-mono text-xs text-slate-900">
                                        {new Date(reservationResult.expiresAt).toLocaleString()}
                                    </div>
                                </div>

                                <div className="p-3 bg-blue-50 text-blue-700 rounded-lg border border-blue-200 text-sm">
                                    📝 Save this token for Phase 2 (Passkey Registration)
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
