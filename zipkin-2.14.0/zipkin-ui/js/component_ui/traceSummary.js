/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// eslint-disable no-nested-ternary
import _ from 'lodash';
import moment from 'moment';
import {getErrorType} from './spanRow';

// To ensure data doesn't scroll off the screen, we need all timestamps, not just
// client/server ones.
export function addTimestamps(span, timestamps) {
  if (!span.timestamp) return;
  timestamps.push(span.timestamp);
  if (!span.duration) return;
  timestamps.push(span.timestamp + span.duration);
}

export function getMaxDuration(timestamps) {
  if (timestamps.length > 1) {
    timestamps.sort();
    return timestamps[timestamps.length - 1] - timestamps[0];
  }
  return 0;
}

function pushEntry(dict, key, value) {
  if (dict[key]) {
    dict[key].push(value);
  } else {
    dict[key] = [value]; // eslint-disable-line no-param-reassign
  }
}

function addServiceNameTimestampDuration(span, groupedTimestamps) {
  const value = {
    timestamp: span.timestamp || 0, // only used by totalDuration
    duration: span.duration || 0
  };

  if (span.localEndpoint && span.localEndpoint.serviceName) {
    pushEntry(groupedTimestamps, span.localEndpoint.serviceName, value);
  }
  // TODO: only do this if it is a leaf span and a client or producer.
  // If we are at the bottom of the tree, it can be helpful to count also against a remote
  // uninstrumented service
  if (span.remoteEndpoint && span.remoteEndpoint.serviceName) {
    pushEntry(groupedTimestamps, span.remoteEndpoint.serviceName, value);
  }
}

// Returns null on empty or when missing a timestamp
export function traceSummary(root) {
  const timestamps = [];
  const groupedTimestamps = {};

  let traceId;
  let spanCount = 0;
  let errorType = 'none';

  root.traverse(span => {
    spanCount++;
    traceId = span.traceId;
    errorType = getErrorType(span, errorType);
    addTimestamps(span, timestamps);
    addServiceNameTimestampDuration(span, groupedTimestamps);
  });

  if (timestamps.length === 0) throw new Error(`Trace ${traceId} is missing a timestamp`);

  return {
    traceId,
    timestamp: timestamps[0],
    duration: getMaxDuration(timestamps),
    groupedTimestamps,
    errorType,
    spanCount
  };
}

// This returns a total duration by merging all overlapping intervals found in the the input.
//
// This is used to create servicePercentage for index.mustache when a service is selected
export function totalDuration(timestampAndDurations) {
  const filtered = _(timestampAndDurations)
    .filter((s) => s.duration) // filter out anything we can't make an interval out of
    .sortBy('timestamp').value(); // to merge intervals, we need the input sorted

  if (filtered.length === 0) {
    return 0;
  }
  if (filtered.length === 1) {
    return filtered[0].duration;
  }

  let result = filtered[0].duration;
  let currentIntervalEnd = filtered[0].timestamp + filtered[0].duration;

  for (let i = 1; i < filtered.length; i++) {
    const next = filtered[i];
    const nextIntervalEnd = next.timestamp + next.duration;

    if (nextIntervalEnd <= currentIntervalEnd) { // we are still in the interval
      continue;
    } else if (next.timestamp <= currentIntervalEnd) { // we extending the interval
      result += nextIntervalEnd - currentIntervalEnd;
      currentIntervalEnd = nextIntervalEnd;
    } else { // this is a new interval
      result += next.duration;
      currentIntervalEnd = nextIntervalEnd;
    }
  }

  return result;
}

function formatDate(timestamp, utc) {
  let m = moment(timestamp / 1000);
  if (utc) {
    m = m.utc();
  }
  return m.format('MM-DD-YYYYTHH:mm:ss.SSSZZ');
}

export function mkDurationStr(duration) {
  if (duration === 0 || typeof duration === 'undefined') {
    return '';
  } else if (duration < 1000) {
    return `${duration.toFixed(0)}μs`;
  } else if (duration < 1000000) {
    if (duration % 1000 === 0) { // Sometimes spans are in milliseconds resolution
      return `${(duration / 1000).toFixed(0)}ms`;
    }
    return `${(duration / 1000).toFixed(3)}ms`;
  } else {
    return `${(duration / 1000000).toFixed(3)}s`;
  }
}

// maxSpanDurationStr is only used in index.mustache
export function getServiceSummaries(groupedTimestamps) {
  return _(groupedTimestamps).toPairs()
    .map(([serviceName, sts]) => ({
      serviceName,
      spanCount: sts.length,
      maxSpanDuration: Math.max(...sts.map(t => t.duration))
    }))
    .orderBy(['maxSpanDuration', 'serviceName'], ['desc', 'asc'])
    .map(summary => ({
      serviceName: summary.serviceName,
      spanCount: summary.spanCount,
      maxSpanDurationStr: mkDurationStr(summary.maxSpanDuration)
    })).value();
}

export function traceSummariesToMustache(serviceName, traceSummaries, utc = false) {
  const maxDuration = Math.max(...traceSummaries.map((s) => s.duration));

  return traceSummaries.map((t) => {
    const timestamp = t.timestamp;

    const res = {
      traceId: t.traceId, // used to navigate to trace screen
      timestamp, // used only for client-side sort
      startTs: formatDate(timestamp, utc),
      spanCount: t.spanCount
    };

    const duration = t.duration || 0;
    if (duration) {
      // used to show the relative duration this trace was compared to others
      res.width = parseInt(parseFloat(duration) / parseFloat(maxDuration) * 100, 10);
      res.duration = duration / 1000; // used only for client-side sort
      res.durationStr = mkDurationStr(duration);
    }

    // groupedTimestamps is keyed by service name, if there are no service names in the trace,
    // don't try to add data dependent on service names.
    if (Object.keys(t.groupedTimestamps).length !== 0) {
      res.serviceSummaries = getServiceSummaries(t.groupedTimestamps);

      // Only add a service percentage when there is a duration for it
      if (serviceName && duration && t.groupedTimestamps[serviceName]) {
        const serviceTime = totalDuration(t.groupedTimestamps[serviceName]);
        // used for display and also client-side sort by service percentage
        res.servicePercentage = parseInt(parseFloat(serviceTime) / parseFloat(duration) * 100, 10);
      }
    }

    if (t.errorType !== 'none') res.infoClass = `trace-error-${t.errorType}`;
    return res;
  }).sort((t1, t2) => {
    const durationComparison = t2.duration - t1.duration;
    if (durationComparison === 0) {
      return t1.traceId.localeCompare(t2.traceId);
    } else {
      return durationComparison;
    }
  });
}
