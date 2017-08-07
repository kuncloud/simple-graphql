// @flow
import _ from 'lodash'

import * as graphql from 'graphql'

import type {GraphQLFieldConfig} from 'graphql'

import Type from '../type'
import Context from '../Context'
import StringHelper from '../utils/StringHelper'
import toGraphQLInputFieldMap from './toGraphQLInputFieldMap'

const toGraphQLFieldConfig = function (name:string,
                                       postfix:string,
                                       fieldType:any,
                                       context:Context,
                                       interfaces:any = []):GraphQLFieldConfig<any, any> {
  const typeName = (path:string) => {
    return path.replace(/\.\$type/g, '').replace(/\[\d*\]/g, '').split('.').map(v => StringHelper.toInitialUpperCase(v)).join('')
  }

  if (graphql.isOutputType(fieldType)) {
    return {type: fieldType}
  }
  if (fieldType instanceof Type.ScalarFieldType) {
    return {type: fieldType.graphQLOutputType}
  }
  switch (fieldType) {
    case String:
      return {type: graphql.GraphQLString}
    case Number:
      return {type: graphql.GraphQLFloat}
    case Boolean:
      return {type: graphql.GraphQLBoolean}
    case Date:
      return {type: Type.GraphQLScalarTypes.Date}
    case JSON:
      return {type: Type.GraphQLScalarTypes.Json}
  }

  if (_.isArray(fieldType)) {
    const elementType = new graphql.GraphQLList(toGraphQLFieldConfig(name, postfix, fieldType[0], context).type)
    return {
      type: elementType,
      resolve: context.wrapFieldResolve({
        name: name.split('.').slice(-1)[0],
        path: name,
        $type: elementType,
        resolve: async function (root) {
          // TODO check?
          const fieldName = name.split('.').slice(-1)[0]
          return root[fieldName]
        }
      })
    }
  }

  if (typeof fieldType === 'string') {
    if (fieldType.endsWith('Edge')) {
      return {
        type: context.edgeType(fieldType.substr(0, fieldType.length - 'Edge'.length))
      }
    } else if (fieldType.endsWith('Connection')) {
      return {
        type: context.connectionType(fieldType.substr(0, fieldType.length - 'Connection'.length))
      }
    } else {
      return {
        type: context.graphQLObjectType(fieldType),
        resolve: context.wrapFieldResolve({
          name: name.split('.').slice(-1)[0],
          path: name,
          $type: context.graphQLObjectType(fieldType),
          resolve: async function (root, args, context, info, models) {
            const fieldName = name.split('.').slice(-1)[0]
            if (_.isFunction(root['get' + StringHelper.toInitialUpperCase(fieldName)])) {
              if (root[fieldName] != null && root[fieldName].id != null) {
                return root[fieldName]
              } else {
                return root['get' + StringHelper.toInitialUpperCase(fieldName)]()
              }
            }
            if (root && root[fieldName] && (
                typeof root[fieldName] === 'number' ||
                typeof root[fieldName] === 'string'
              )) {
              return models[fieldType].findOne({where: {id: root[fieldName]}})
            }
            return root[fieldName]
          }
        })
      }
    }
  }

  if (fieldType instanceof Object) {
    if (fieldType['$type']) {
      const result = toGraphQLFieldConfig(name, postfix, fieldType['$type'], context)
      if (fieldType['enumValues']) {
        const values = {}
        fieldType['enumValues'].forEach(
          t => {
            values[t] = {value: t}
          }
        )
        result.type = new graphql.GraphQLEnumType({
          name: typeName(name) + postfix,
          values: values
        })
      }
      if (fieldType['required'] && !(result.type instanceof graphql.GraphQLNonNull)) {
        result.type = new graphql.GraphQLNonNull(result.type)
      }
      if (fieldType['resolve']) {
        result['resolve'] = context.wrapFieldResolve({
          name: name.split('.').slice(-1)[0],
          path: name,
          $type: result.type,
          resolve: fieldType['resolve']
        })
      }
      if (fieldType['args']) {
        result['args'] = toGraphQLInputFieldMap(typeName(name), fieldType['args'])
      }
      result.description = fieldType['description']
      return result
    } else {
      const objType = new graphql.GraphQLObjectType({
        name: typeName(name) + postfix,
        interfaces: interfaces,
        fields: () => {
          const fields = {}
          _.forOwn(fieldType, (value, key) => {
            if (value['$type'] && value['hidden']) {
            } else {
              fields[key] = toGraphQLFieldConfig(name + postfix + '.' + key, '', value, context)
            }
          })
          return fields
        }
      })
      return {
        type: objType,
        resolve: context.wrapFieldResolve({
          name: name.split('.').slice(-1)[0],
          path: name,
          $type: objType,
          resolve: async function (root) {
            return root[name.split('.').slice(-1)[0]]
          }
        })
      }
    }
  }
  throw new Error('Unsupported type: ' + fieldType)
}

export default toGraphQLFieldConfig
