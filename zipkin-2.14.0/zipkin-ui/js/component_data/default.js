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
import {component} from 'flightjs';
import {errToStr} from '../../js/component_ui/error';
import $ from 'jquery';
import queryString from 'query-string';
import {traceSummary, traceSummariesToMustache} from '../component_ui/traceSummary';
import {treeCorrectedForClockSkew} from '../component_data/skew';

const debug = false;

export function convertDurationToMicrosecond(duration) {
  const match = duration.match(/^(\d+)(us|μs|ms|s)$/i);
  if (match) {
    const unit = match[2];
    switch (unit) {
      case 'us':
      case 'μs':
        return match[1];
      case 'ms':
        return String((Number(match[1]) * 1000));
      case 's':
        return String((Number(match[1]) * Math.pow(1000, 2)));
      default:
        // Do nothing
    }
  }
  return duration;
}

export function convertToApiQuery(source) {
  const query = Object.assign({}, source);

  if (query.minDuration) {
    query.minDuration = convertDurationToMicrosecond(query.minDuration);
  }

  // zipkin's api looks back from endTs
  if (query.lookback !== 'custom') {
    delete query.startTs;
    delete query.endTs;
  }
  if (query.startTs) {
    if (query.endTs > query.startTs) {
      query.lookback = String(query.endTs - query.startTs);
    }
    delete query.startTs;
  }
  if (query.lookback === 'custom') {
    delete query.lookback;
  }
  if (query.serviceName === 'all') {
    delete query.serviceName;
  }
  if (query.remoteServiceName === 'all') {
    delete query.remoteServiceName;
  }
  if (query.spanName === 'all') {
    delete query.spanName;
  }
  // delete any parameters unused on the server
  Object.keys(query).forEach(key => {
    if (query[key] === '') {
      delete query[key];
    }
  });
  delete query.sortOrder;
  return query;
}

// Converts the response into data for index.mustache. Traces missing required data are skipped.
export function convertSuccessResponse(rawResponse, serviceName, apiURL, utc = false) {
  const summaries = [];
  rawResponse.forEach((raw) => {
    if (raw.length === 0) return;

    const corrected = treeCorrectedForClockSkew(raw);
    try {
      summaries.push(traceSummary(corrected));
    } catch (e) {
      /* eslint-disable no-console */
      if (debug) console.log(e.toString());
    }
  });

  // Take the summaries and convert them to template parameters for index.mustache
  let traces = [];
  if (summaries.length > 0) {
    traces = traceSummariesToMustache(serviceName, summaries, utc);
  }
  return {traces, apiURL, rawResponse};
}

export default component(function DefaultData() {
  this.after('initialize', function() {
    const query = queryString.parse(window.location.search);
    const serviceName = query.serviceName;
    if (!serviceName) {
      this.trigger('defaultPageModelView', {traces: []});
      return;
    }
    const apiQuery = convertToApiQuery(query);
    const apiURL = `api/v2/traces?${queryString.stringify(apiQuery)}`;
    $.ajax(apiURL, {
      type: 'GET',
      dataType: 'json'
    }).done(rawTraces => {
      this.trigger('defaultPageModelView', convertSuccessResponse(rawTraces, serviceName, apiURL));
    }).fail(e => {
      this.trigger('defaultPageModelView', {traces: [], queryError: errToStr(e)});
    });
  });
});
